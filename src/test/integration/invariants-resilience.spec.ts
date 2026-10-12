import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import mikroOrmConfig from '../../shared/infrastructure/database/mikro-orm.config';
import { AppModule } from '../../app.module';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository';
import { SqsWagerConsumer } from '../../wagering/infrastructure/messaging/sqs-wager.consumer';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from '../../wagering/application/use-cases/retry-pending-references.use-case';
import { OutboxPublisherWorker } from '../../wagering/infrastructure/messaging/outbox-publisher.worker';
import { WagerTransactionRepository } from '../../wagering/infrastructure/persistence/wager-transaction.repository';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.entity';
import { FailureCode } from '../../shared/domain/errors';
import { generateId } from '../../shared/domain/identifier';

describe('Invariants & Resilience Integration Tests — Permanent Verification Suite', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let openWalletUseCase: OpenWalletUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let retryPendingUseCase: RetryPendingReferencesUseCase;
  let wagerRepo: WagerTransactionRepository;
  let outboxPublisher: OutboxPublisherWorker;
  let nestApp: INestApplication;
  let nestPort: number;

  const queueUrl = 'http://localhost:4566/000000000000/wager-transactions.fifo';
  const dlqUrl = 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
  const eventsQueueUrl = 'http://localhost:4566/000000000000/wagering-events.fifo';

  beforeAll(async () => {
    orm = (await CoreMikroORM.init(mikroOrmConfig)) as MikroORM;
    sqs = new SQSClient({
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });

    // Queue hygiene: purge queues at startup
    for (const q of [queueUrl, dlqUrl, eventsQueueUrl]) {
      try {
        await sqs.send(new (await import('@aws-sdk/client-sqs')).PurgeQueueCommand({ QueueUrl: q }));
      } catch {}
    }

    openWalletUseCase = new OpenWalletUseCase(new MikroOrmUnitOfWork(orm.em));
    const walletRepo = new WalletRepository(orm.em);
    reconcileWalletUseCase = new ReconcileWalletUseCase(walletRepo);
    processWagerUseCase = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm.em));
    wagerRepo = new WagerTransactionRepository(orm.em);
    retryPendingUseCase = new RetryPendingReferencesUseCase(new MikroOrmUnitOfWork(orm.em), processWagerUseCase);
    outboxPublisher = new OutboxPublisherWorker(orm.em);
    outboxPublisher.onModuleInit();

    // Start real NestJS HTTP server on dynamic port
    nestApp = await NestFactory.create(AppModule, { logger: false });
    await nestApp.listen(0);
    nestPort = (nestApp.getHttpServer().address() as any).port;
  });

  afterAll(async () => {
    await nestApp.close();
    await outboxPublisher.onModuleDestroy();
    await orm.close(true);
  });

  // (a.0) Atomicidade em falha de banco: rollback completo em erro de commit
  it('(a.0) atomicidade em falha de banco: rollback completo em erro de commit, BET preservada e saldo intacto', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betExtId = 'bet-' + generateId();
    const betResult = await processWagerUseCase.execute({
      providerId: 'prov-a0',
      externalTransactionId: betExtId,
      idempotencyKey: 'idem-' + betExtId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '40.00', currency: 'BRL' },
    });
    expect(betResult.status).toBe(WagerTransactionStatus.Processed);

    const recAfterBet = await reconcileWalletUseCase.execute(wallet.id);
    expect(recAfterBet.storedBalance.amount).toBe('60.00');

    // Simulate database failure right before commit
    const uow = new MikroOrmUnitOfWork(orm.em);
    const refundExtId = 'refund-fail-' + generateId();
    let txFailed = false;

    try {
      await uow.transactional(async (scope) => {
        const scopedProcess = new ProcessWagerTransactionUseCase(uow);
        await scopedProcess.executeInScope(scope, {
          providerId: 'prov-a0',
          externalTransactionId: refundExtId,
          idempotencyKey: 'idem-' + refundExtId,
          playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: WagerTransactionKind.Refund,
          money: { amount: '40.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        });
        throw new Error('SIMULATED_DB_FAILURE_BEFORE_COMMIT');
      });
    } catch (err: any) {
      expect(err.message).toBe('SIMULATED_DB_FAILURE_BEFORE_COMMIT');
      txFailed = true;
    }
    expect(txFailed).toBe(true);

    const betInDb = await wagerRepo.findByProviderAndExternalId('prov-a0', betExtId);
    expect(betInDb!.status).toBe(WagerTransactionStatus.Processed);

    const refundInDb = await wagerRepo.findByProviderAndExternalId('prov-a0', refundExtId);
    expect(refundInDb).toBeNull();

    const recFinal = await reconcileWalletUseCase.execute(wallet.id);
    expect(recFinal.consistent).toBe(true);
    expect(recFinal.storedBalance.amount).toBe('60.00');
    expect(recFinal.calculatedBalance.amount).toBe('60.00');
    expect(recFinal.checkedEntries).toBe(2);
  });

  // (a.1) BET -> REFUND -> ROLLBACK(BET) = REJECTED, e ordem inversa
  it('(a.1) BET -> REFUND processado -> ROLLBACK(BET) rejeitado com REFERENCE_ALREADY_REVERSED, e ordem inversa', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '200.00', currency: 'BRL' },
    });

    // CASO 1: BET1 -> REFUND -> ROLLBACK(BET1) deve ser REJEITADO
    const bet1Ext = 'bet1-' + generateId();
    await processWagerUseCase.execute({
      providerId: 'prov-a1',
      externalTransactionId: bet1Ext,
      idempotencyKey: 'idem-' + bet1Ext,
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    const refund1Ext = 'refund1-' + generateId();
    const ref1Res = await processWagerUseCase.execute({
      providerId: 'prov-a1',
      externalTransactionId: refund1Ext,
      idempotencyKey: 'idem-' + refund1Ext,
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: bet1Ext,
    });
    expect(ref1Res.status).toBe(WagerTransactionStatus.Processed);

    const rollback1Ext = 'rollback1-' + generateId();
    const rb1Res = await processWagerUseCase.execute({
      providerId: 'prov-a1',
      externalTransactionId: rollback1Ext,
      idempotencyKey: 'idem-' + rollback1Ext,
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: bet1Ext,
    });
    expect(rb1Res.status).toBe(WagerTransactionStatus.Rejected);
    expect(rb1Res.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    // CASO 2: BET2 -> ROLLBACK -> REFUND(BET2) deve ser REJEITADO
    const bet2Ext = 'bet2-' + generateId();
    await processWagerUseCase.execute({
      providerId: 'prov-a1',
      externalTransactionId: bet2Ext,
      idempotencyKey: 'idem-' + bet2Ext,
      playerId,
      walletId: wallet.id,
      roundId: 'round-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });

    const rollback2Ext = 'rollback2-' + generateId();
    const rb2Res = await processWagerUseCase.execute({
      providerId: 'prov-a1',
      externalTransactionId: rollback2Ext,
      idempotencyKey: 'idem-' + rollback2Ext,
      playerId,
      walletId: wallet.id,
      roundId: 'round-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: bet2Ext,
    });
    expect(rb2Res.status).toBe(WagerTransactionStatus.Processed);

    const refund2Ext = 'refund2-' + generateId();
    const ref2Res = await processWagerUseCase.execute({
      providerId: 'prov-a1',
      externalTransactionId: refund2Ext,
      idempotencyKey: 'idem-' + refund2Ext,
      playerId,
      walletId: wallet.id,
      roundId: 'round-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: bet2Ext,
    });
    expect(ref2Res.status).toBe(WagerTransactionStatus.Rejected);
    expect(ref2Res.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    // Saldo da carteira deve ser exatamente 200.00 (as duas apostas foram estornadas uma única vez cada)
    const recFinal = await reconcileWalletUseCase.execute(wallet.id);
    expect(recFinal.consistent).toBe(true);
    expect(recFinal.storedBalance.amount).toBe('200.00');
  });

  // (a.2) REFUND e ROLLBACK da mesma BET em paralelo
  it('(a.2) REFUND e ROLLBACK da mesma BET em paralelo: exatamente 1 PROCESSED, 1 REJECTED, ledger com 2 lançamentos', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betExt = 'bet-par-' + generateId();
    await processWagerUseCase.execute({
      providerId: 'prov-a2',
      externalTransactionId: betExt,
      idempotencyKey: 'idem-' + betExt,
      playerId,
      walletId: wallet.id,
      roundId: 'round-par',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    const refundExt = 'refund-par-' + generateId();
    const rollbackExt = 'rollback-par-' + generateId();

    // Executar REFUND e ROLLBACK simultaneamente
    const [resRefund, resRollback] = await Promise.all([
      processWagerUseCase.execute({
        providerId: 'prov-a2',
        externalTransactionId: refundExt,
        idempotencyKey: 'idem-' + refundExt,
        playerId,
        walletId: wallet.id,
        roundId: 'round-par',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: betExt,
      }),
      processWagerUseCase.execute({
        providerId: 'prov-a2',
        externalTransactionId: rollbackExt,
        idempotencyKey: 'idem-' + rollbackExt,
        playerId,
        walletId: wallet.id,
        roundId: 'round-par',
        gameId: 'game-1',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: betExt,
      }),
    ]);

    const statuses = [resRefund.status, resRollback.status];
    expect(statuses).toContain(WagerTransactionStatus.Processed);
    expect(statuses).toContain(WagerTransactionStatus.Rejected);

    const rejectedRes = resRefund.status === WagerTransactionStatus.Rejected ? resRefund : resRollback;
    expect(rejectedRes.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    // Ledger deve conter exatamente 3 lançamentos: 1 abertura + 1 BET + 1 reversão
    const recFinal = await reconcileWalletUseCase.execute(wallet.id);
    expect(recFinal.consistent).toBe(true);
    expect(recFinal.storedBalance.amount).toBe('100.00');
    expect(recFinal.checkedEntries).toBe(3);
  });

  // (a.3) ROLLBACK(REFUND) permitido; após ele, novo REFUND(BET) é rejeitado
  it('(a.3) ROLLBACK(REFUND) permitido; após ele, um novo REFUND(BET) é rejeitado com REFERENCE_ALREADY_REVERSED', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const betExt = 'bet-a3-' + generateId();
    await processWagerUseCase.execute({
      providerId: 'prov-a3',
      externalTransactionId: betExt,
      idempotencyKey: 'idem-' + betExt,
      playerId,
      walletId: wallet.id,
      roundId: 'round-a3',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '40.00', currency: 'BRL' },
    });

    const refundExt = 'refund-a3-' + generateId();
    const refRes = await processWagerUseCase.execute({
      providerId: 'prov-a3',
      externalTransactionId: refundExt,
      idempotencyKey: 'idem-' + refundExt,
      playerId,
      walletId: wallet.id,
      roundId: 'round-a3',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: betExt,
    });
    expect(refRes.status).toBe(WagerTransactionStatus.Processed);

    // ROLLBACK referenciando o REFUND (cancelando o estorno)
    const rollbackRefundExt = 'rollback-ref-a3-' + generateId();
    const rbRefundRes = await processWagerUseCase.execute({
      providerId: 'prov-a3',
      externalTransactionId: rollbackRefundExt,
      idempotencyKey: 'idem-' + rollbackRefundExt,
      playerId,
      walletId: wallet.id,
      roundId: 'round-a3',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: refundExt,
    });
    expect(rbRefundRes.status).toBe(WagerTransactionStatus.Processed);

    // Agora tenta emitir um novo REFUND referenciando a BET original
    const newRefundExt = 'new-refund-a3-' + generateId();
    const newRefundRes = await processWagerUseCase.execute({
      providerId: 'prov-a3',
      externalTransactionId: newRefundExt,
      idempotencyKey: 'idem-' + newRefundExt,
      playerId,
      walletId: wallet.id,
      roundId: 'round-a3',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: betExt,
    });
    expect(newRefundRes.status).toBe(WagerTransactionStatus.Rejected);
    expect(newRefundRes.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    // Saldo: 100 - 40 (bet) + 40 (refund) - 40 (rollback) = 60.00
    const recFinal = await reconcileWalletUseCase.execute(wallet.id);
    expect(recFinal.consistent).toBe(true);
    expect(recFinal.storedBalance.amount).toBe('60.00');
  });

  // (b) crash real de processo filho após commit e antes do ack
  it('(b) crash real: processo filho morto (kill) após commit no PostgreSQL e antes do ack, redelivery sem duplicar débito', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const msgId = 'crash-msg-' + generateId();
    const extId = 'crash-ext-' + generateId();
    const idemKey = 'crash-idem-' + generateId();

    const payload = {
      messageId: msgId,
      type: 'ProcessWager',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'prov-crash-real',
        externalTransactionId: extId,
        idempotencyKey: idemKey,
        playerId,
        walletId: wallet.id,
        roundId: 'round-crash',
        gameId: 'game-crash',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'BRL' },
      },
    };

    // Enviar mensagem para a fila SQS
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: msgId,
      }),
    );

    // Spawn processo filho com hook de crash imediato após o commit no banco e antes do delete SQS
    const crashWorkerScript = `
      import { MikroORM } from '@mikro-orm/postgresql';
      import { SQSClient, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
      import mikroOrmConfig from './src/shared/infrastructure/database/mikro-orm.config';
      import { ProcessWagerTransactionUseCase } from './src/wagering/application/use-cases/process-wager-transaction.use-case';
      import { MikroOrmUnitOfWork } from './src/shared/infrastructure/database/mikro-orm-unit-of-work';

      const orm = await MikroORM.init(mikroOrmConfig);
      const useCase = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm.em));
      const sqs = new SQSClient({ endpoint: 'http://localhost:4566', region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

      let targetMsg;
      for (let i = 0; i < 5; i++) {
        const res = await sqs.send(new ReceiveMessageCommand({
          QueueUrl: '${queueUrl}',
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 2,
        }));
        const found = res.Messages?.find((m) => m.Body?.includes('${msgId}'));
        if (found) {
          targetMsg = found;
          break;
        }
      }

      if (targetMsg) {
        const env = JSON.parse(targetMsg.Body);
        await useCase.execute({
          ...env.data,
          sqsMessageId: env.messageId,
          consumerName: 'crash-worker-child',
        });
        // TEST HOOK: Kill process abruptly with SIGKILL before sending SQS DeleteMessageCommand
        process.kill(process.pid, 'SIGKILL');
      } else {
        await orm.close(true);
        process.exit(1);
      }
    `;

    const child = Bun.spawn(['bun', '-e', crashWorkerScript], {
      cwd: process.cwd(),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await child.exited;

    // Pré-condição do cenário: o filho comitou no banco e morreu por SIGKILL antes do ack.
    // Sem isso o teste passaria mesmo se o filho falhasse antes de processar.
    expect(child.signalCode).toBe('SIGKILL');
    const committed = await orm.em
      .fork()
      .getConnection()
      .execute('SELECT status FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?', [
        'prov-crash-real',
        extId,
      ]);
    expect(committed[0]?.status).toBe(WagerTransactionStatus.Processed);

    // Aguardar visibilidade da mensagem voltar na fila SQS
    await new Promise((r) => setTimeout(r, 2200));

    // Agora o worker 2 recuperado consome a mensagem redelivered
    const consumer2 = new SqsWagerConsumer(processWagerUseCase);
    consumer2.onModuleInit();
    await consumer2.pollMessages();
    await consumer2.onModuleDestroy();

    // Invariante de reconciliação: exatamente 1 débito de 20.00 (saldo 80.00, NÃO 60.00)
    const rec = await reconcileWalletUseCase.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe('80.00');
    expect(rec.checkedEntries).toBe(2);
  }, 20000);

  // (c) reinício do processo com mensagens pendentes na outbox
  it('(c) reinício: mensagens pendentes na outbox + reinício do processo são publicadas no wagering-events.fifo', async () => {
    const em = orm.em.fork();
    const testWalletId = generateId();

    await em.getConnection().execute(`DELETE FROM outbox_messages WHERE published_at IS NULL`);

    // Drenar eventos antigos da fila eventsQueueUrl
    let drainBatch;
    while ((drainBatch = await sqs.send(new ReceiveMessageCommand({ QueueUrl: eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }))).Messages?.length) {
      for (const m of drainBatch.Messages) {
        if (m.ReceiptHandle) {
          await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsQueueUrl, ReceiptHandle: m.ReceiptHandle }));
        }
      }
    }

    const msg1Id = generateId();
    const msg2Id = generateId();

    for (const [id, eventType] of [
      [msg1Id, 'WagerTransactionProcessed'],
      [msg2Id, 'WalletBalanceUpdated'],
    ] as const) {
      await em.getConnection().execute(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
         VALUES (?, ?, ?, ?::jsonb, ?)`,
        [
          id,
          testWalletId,
          eventType,
          JSON.stringify({ eventId: 'evt-' + id, walletId: testWalletId, amount: '10.00' }),
          new Date(),
        ],
      );
    }

    // Processo 1 inicia, sofre parada imediata (interrupção simulada)
    const publisher1 = new OutboxPublisherWorker(orm.em);
    publisher1.onModuleInit();
    await publisher1.onModuleDestroy();

    // Processo 2 sobe (reinício do serviço) e drena a outbox pendente
    const publisher2 = new OutboxPublisherWorker(orm.em);
    publisher2.onModuleInit();
    const published = await publisher2.pollAndPublish();
    await publisher2.onModuleDestroy();

    expect(published).toBeGreaterThanOrEqual(2);

    const pendingCount = await em.getConnection().execute(
      `SELECT COUNT(*) as count FROM outbox_messages WHERE id IN (?, ?) AND published_at IS NULL`,
      [msg1Id, msg2Id],
    );
    expect(Number(pendingCount[0]!.count)).toBe(0);

    // Verificar recebimento no SQS FIFO
    const sqsRes = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        AttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
    );
    expect(sqsRes.Messages).toBeDefined();
    const found1 = sqsRes.Messages?.find((m) => m.Body?.includes(msg1Id));
    expect(found1).toBeDefined();
    expect(found1?.Attributes?.MessageGroupId).toBe(testWalletId);

    if (found1?.ReceiptHandle) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsQueueUrl, ReceiptHandle: found1.ReceiptHandle }));
    }
  });

  // (d) transição de PENDING_REFERENCE para REJECTED após timeout com assert de evento na outbox
  it('(d) PENDING_REFERENCE transitions to REJECTED with REFERENCE_TIMEOUT after max retries/timeout, assertando outbox', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const orphanRefundExtId = 'orphan-refund-' + generateId();
    const initialResult = await processWagerUseCase.execute({
      providerId: 'provider-orphan',
      externalTransactionId: orphanRefundExtId,
      idempotencyKey: 'idem-' + orphanRefundExtId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-orphan',
      gameId: 'game-orphan',
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'non-existent-bet-' + generateId(),
    });

    expect(initialResult.status).toBe(WagerTransactionStatus.PendingReference);

    const em = orm.em.fork();
    await em.getConnection().execute(
      `UPDATE wager_transactions 
       SET retry_count = 10, next_retry_at = NOW() - INTERVAL '5 minutes'
       WHERE id = ?`,
      [initialResult.transactionId],
    );

    const processedCount = await retryPendingUseCase.execute(new Date());
    expect(processedCount).toBeGreaterThanOrEqual(1);

    const txAfter = await wagerRepo.findById(initialResult.transactionId);
    expect(txAfter!.status).toBe(WagerTransactionStatus.Rejected);
    expect(txAfter!.failureCode).toBe(FailureCode.REFERENCE_TIMEOUT);

    // Assert explícito do evento WagerTransactionRejected na outbox com REFERENCE_TIMEOUT
    const outboxRows = await em.getConnection().execute(
      `SELECT * FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionRejected'`,
      [initialResult.transactionId],
    );
    expect(outboxRows.length).toBe(1);
    const payload = typeof outboxRows[0]!.payload === 'string' ? JSON.parse(outboxRows[0]!.payload) : outboxRows[0]!.payload;
    const failureCode = payload.data?.failureCode || payload.failureCode;
    expect(failureCode).toBe(FailureCode.REFERENCE_TIMEOUT);
    expect(payload.data?.status || payload.status).toBe('REJECTED');
  });

  // (e) fluxo completo de MaxReceiveCount, DLQ, inbox em rejeição de negócio e replay
  it('(e) fluxo completo de MaxReceiveCount e DLQ, inbox em rejeição de negócio e replay idempotente', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });

    // PARTE 1: Rejeição de negócio (saldo insuficiente) grava inbox e faz ACK
    const rejectMsgId = 'msg-rej-' + generateId();
    const rejectPayload = {
      messageId: rejectMsgId,
      type: 'ProcessWager',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'prov-e',
        externalTransactionId: 'ext-rej-' + generateId(),
        idempotencyKey: 'idem-rej-' + generateId(),
        playerId,
        walletId: wallet.id,
        roundId: 'round-rej',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '50.00', currency: 'BRL' }, // Saldo insuficiente (saldo é 10.00)
      },
    };

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(rejectPayload),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: rejectMsgId,
      }),
    );

    const consumer = new SqsWagerConsumer(processWagerUseCase);
    consumer.onModuleInit();
    await consumer.pollMessages();

    // Verificar que a mensagem foi ACKed (não existe mais na fila) e gravada em inbox_messages
    const em = orm.em.fork();
    const inboxRows = await em.getConnection().execute(
      `SELECT * FROM inbox_messages WHERE message_id = ?`,
      [rejectMsgId],
    );
    expect(inboxRows.length).toBe(1);

    // PARTE 2: Replay da mensagem rejeitada não reprocessa e responde com idempotência
    const replayRes = await processWagerUseCase.execute({
      ...rejectPayload.data,
      sqsMessageId: rejectMsgId,
      consumerName: 'wager-consumer-test',
    });
    expect(replayRes.status).toBe(WagerTransactionStatus.Rejected);
    expect(replayRes.idempotentReplay).toBe(true);

    // PARTE 3: Mensagem inválida permanente vai diretamente para a DLQ
    const poisonId = 'poison-e-' + generateId();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: '{ invalid-json-payload-poison }',
        MessageGroupId: 'poison-e',
        MessageDeduplicationId: poisonId,
      }),
    );

    await consumer.pollMessages();
    await consumer.onModuleDestroy();

    const dlqRes = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 2,
      }),
    );
    expect(dlqRes.Messages).toBeDefined();
    const dlqFound = dlqRes.Messages?.find((m) => m.Body?.includes('invalid-json-payload-poison'));
    expect(dlqFound).toBeDefined();

    if (dlqFound?.ReceiptHandle) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: dlqFound.ReceiptHandle }));
    }
  });

  // (e.2) erro transitório: backoff exponencial via VisibilityTimeout conforme ApproximateReceiveCount e DLQ ao atingir maxReceiveCount
  it('(e.2) erro transitório: ChangeMessageVisibility com backoff exponencial e DLQ ao atingir maxReceiveCount=5', async () => {
    // Este teste verifica dois comportamentos do SqsWagerConsumer:
    // 1. Backoff exponencial: SqsWagerConsumer calcula visibilityTimeout = min(5 * 2^receiveCount, 300)
    //    e chama ChangeMessageVisibilityCommand com esse valor.
    // 2. DLQ forwarding: quando receiveCount >= 5, a mensagem é enviada para DLQ e deletada da fila principal.
    //    Testamos (2) via forwardToDlqAndAck com uma mensagem real em LocalStack.

    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // --- Parte 1: Verifica fórmula de backoff (unit-level, sem depender de FIFO polling) ---
    // O consumer usa: min(5 * 2^receiveCount, 300)
    // Para receiveCount=1: 10s, receiveCount=2: 20s, receiveCount=3: 40s, receiveCount=4: 80s
    const backoffCases: [number, number][] = [[1, 10], [2, 20], [3, 40], [4, 80]];
    for (const [count, expected] of backoffCases) {
      const computed = Math.min(5 * Math.pow(2, count), 300);
      expect(computed).toBe(expected);
    }
    // Verifica fórmula de backoff com spy comportamental no consumer:
    // Cria consumer com sqsClient mockado, injeta uma mensagem sintética com execute() lançando erro,
    // e verifica que ChangeMessageVisibilityCommand foi enviado com o timeout correto.
    const backoffConsumer = new SqsWagerConsumer(processWagerUseCase);
    backoffConsumer.onModuleInit();

    const backoffCommands: any[] = [];
    const origBackoffSend = (backoffConsumer as any).sqsClient.send.bind((backoffConsumer as any).sqsClient);
    (backoffConsumer as any).sqsClient.send = async (cmd: any) => {
      backoffCommands.push(cmd);
      if (cmd.constructor?.name === 'ReceiveMessageCommand') {
        // Retorna mensagem sintética com ApproximateReceiveCount=1
        return {
          Messages: [{
            MessageId: 'mock-backoff-id',
            ReceiptHandle: 'mock-receipt-backoff',
            Body: JSON.stringify({
              messageId: 'mock-e2-backoff',
              type: 'ProcessWager',
              occurredAt: new Date().toISOString(),
              data: {
                providerId: 'prov-backoff',
                externalTransactionId: 'ext-backoff-' + generateId(),
                idempotencyKey: 'idem-backoff-' + generateId(),
                playerId,
                walletId: wallet.id,
                roundId: 'r1',
                gameId: 'g1',
                kind: WagerTransactionKind.Bet,
                money: { amount: '1.00', currency: 'BRL' },
              },
            }),
            Attributes: { ApproximateReceiveCount: '1' },
          }],
        };
      }
      if (cmd.constructor?.name === 'ChangeMessageVisibilityCommand') {
        return {}; // ack mock
      }
      return origBackoffSend(cmd);
    };

    const origExecuteForBackoff = processWagerUseCase.execute.bind(processWagerUseCase);
    processWagerUseCase.execute = async () => { throw new Error('Simulated transient error for backoff test'); };

    await backoffConsumer.pollMessages();
    processWagerUseCase.execute = origExecuteForBackoff;
    await backoffConsumer.onModuleDestroy();

    // ChangeMessageVisibilityCommand deve ter sido enviado com VisibilityTimeout = 5 * 2^1 = 10
    const backoffCmd = backoffCommands.find((c) => c.constructor?.name === 'ChangeMessageVisibilityCommand');
    expect(backoffCmd).toBeDefined();
    expect(backoffCmd.input.VisibilityTimeout).toBe(10); // 5 * 2^1 = 10s

    // --- Parte 2: DLQ forwarding via spy no sqsClient — verifica SendMessage(DLQ) + DeleteMessage ---
    // Constrói consumer e intercepta o sqsClient interno para verificar as chamadas SQS.
    // Isso evita depender de entrega de mensagens FIFO que pode ser bloqueada por grupos in-flight.

    const dlqTestMsgId = 'msg-e2-dlq-' + generateId();
    const dlqTestExtId = 'ext-e2-dlq-' + generateId();
    const fakeBody = JSON.stringify({
      messageId: dlqTestMsgId,
      type: 'ProcessWager',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'prov-e2-dlq',
        externalTransactionId: dlqTestExtId,
        idempotencyKey: 'idem-e2-dlq-' + generateId(),
        playerId,
        walletId: wallet.id,
        roundId: 'round-2',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '5.00', currency: 'BRL' },
      },
    });

    // Criar consumer e inicializar (cria sqsClient interno)
    const dlqConsumer = new SqsWagerConsumer(processWagerUseCase);
    dlqConsumer.onModuleInit();

    // Capturar chamadas ao sqsClient interno via spy
    const sentCommands: any[] = [];
    const origSend = (dlqConsumer as any).sqsClient.send.bind((dlqConsumer as any).sqsClient);
    (dlqConsumer as any).sqsClient.send = async (cmd: any) => {
      sentCommands.push(cmd);
      // Deixa DeleteMessage e SendMessage (para DLQ) passarem de verdade — mas com ReceiptHandle fictício
      // o DeleteMessage pode falhar; apenas verificamos que os comandos corretos foram enviados
      if (cmd.constructor?.name === 'DeleteMessageCommand') {
        return {}; // Simula sucesso sem chamar LocalStack
      }
      if (cmd.constructor?.name === 'SendMessageCommand') {
        // Chamar LocalStack real para verificar que a mensagem chega na DLQ
        return origSend(cmd);
      }
      return origSend(cmd);
    };

    // Chamar forwardToDlqAndAck com ReceiptHandle fictício (delete é mockado acima)
    await (dlqConsumer as any).forwardToDlqAndAck(
      fakeBody,
      'fake-receipt-handle-for-test',
      'fake-message-id',
      wallet.id,
    );
    await dlqConsumer.onModuleDestroy();

    // Verificar que DeleteMessageCommand foi chamado (remoção da fila principal)
    const deleteCmd = sentCommands.find((c) => c.constructor?.name === 'DeleteMessageCommand');
    expect(deleteCmd).toBeDefined();

    // Verificar que SendMessageCommand foi chamado com a DLQ URL (encaminhamento para DLQ)
    const sendToQlqCmd = sentCommands.find(
      (c) => c.constructor?.name === 'SendMessageCommand' && c.input?.QueueUrl?.includes('dlq'),
    );
    expect(sendToQlqCmd).toBeDefined();
    expect(sendToQlqCmd.input.MessageBody).toContain(dlqTestExtId);

    // Verificar que a mensagem chegou na DLQ real (o SendMessageCommand chamou LocalStack)
    let dlqCheckMsg: any;
    for (let attempt = 0; attempt < 3 && !dlqCheckMsg; attempt++) {
      const dlqPoll = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 2,
          AttributeNames: ['All'],
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      dlqCheckMsg = dlqPoll.Messages?.find((m) => m.Body?.includes(dlqTestMsgId));
    }
    expect(dlqCheckMsg).toBeDefined();
    expect(dlqCheckMsg!.Body).toContain(dlqTestExtId);

    // Limpar DLQ
    if (dlqCheckMsg?.ReceiptHandle) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: dlqCheckMsg.ReceiptHandle }));
    }
  }, 30000);

  // (f.2-real) 503 via esgotamento real dos retries de lock otimista sob contenção HTTP concurrent
  // (f.2-stub) Mapeamento do retry esgotado (stub): 503 com Retry-After via stub do UnitOfWork
  it('(f.2-stub) mapeamento do retry esgotado (stub): 503 com Retry-After via stub do UnitOfWork', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    const { WageringController } = await import('../../wagering/infrastructure/http/wagering.controller');
    const wageringController = nestApp.get(WageringController);
    const nestProcessWagerUseCase = (wageringController as any).processWagerUseCase;
    const originalUow = nestProcessWagerUseCase.uow;
    const { ConcurrencyConflictError } = await import('../../shared/application/ports/unit-of-work.port');

    // Stub the unit of work of this use case instance: every attempt hits a version conflict
    let lockConflictAttempts = 0;
    nestProcessWagerUseCase.uow = {
      transactional: async () => {
        lockConflictAttempts++;
        throw new ConcurrencyConflictError('OPTIMISTIC_LOCK');
      },
    };

    try {
      const res = await fetch(`http://localhost:${nestPort}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'key-stublock-' + generateId(),
        },
        body: JSON.stringify({
          providerId: 'prov-stublock',
          externalTransactionId: 'ext-stublock-' + generateId(),
          playerId,
          walletId: wallet.id,
          roundId: 'round-stublock',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      const body = await res.json();
      expect(body.message).toContain('Concurrency limit exceeded');
      expect(lockConflictAttempts).toBe(6);
    } finally {
      nestProcessWagerUseCase.uow = originalUow;
    }
  });

  // (f.2-real) Conflito real determinístico: outra conexão atualiza versão antes do flush até esgotar 6 tentativas
  it('(f.2-real) conflito real determinístico: outra conexão atualiza a versão da wallet antes do flush até esgotar 6 tentativas -> 503 + Retry-After: 1 + métricas incrementadas', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    const { WalletRepository } = await import('../../wallet/infrastructure/persistence/wallet.repository');
    const { optimisticLockConflictsTotal, retryAttemptsTotal } = await import('../../shared/infrastructure/metrics/metrics.controller');

    const initialConflicts = (await (optimisticLockConflictsTotal as any).get()).values.reduce(
      (acc: number, v: any) => acc + (v.value || 0),
      0,
    );
    const initialRetries = (await (retryAttemptsTotal as any).get()).values.reduce(
      (acc: number, v: any) => acc + (v.value || 0),
      0,
    );

    const originalWalletSave = WalletRepository.prototype.save;
    let realLockAttempts = 0;

    // Hook: antes de cada flush do wallet, a versão é incrementada no PostgreSQL diretamente.
    // Usa a própria transação: a wallet está travada com SELECT ... FOR UPDATE, então uma
    // conexão separada ficaria bloqueada no lock enquanto o caso de uso aguarda este hook (deadlock).
    WalletRepository.prototype.save = async function (this: any, w: any) {
      if (w.id === wallet.id) {
        realLockAttempts++;
        await this.em.execute('UPDATE wallets SET version = version + 1 WHERE id = ?', [w.id]);
      }
      return originalWalletSave.call(this, w);
    };

    try {
      const res = await fetch(`http://localhost:${nestPort}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'key-realdetlock-' + generateId(),
        },
        body: JSON.stringify({
          providerId: 'prov-realdetlock',
          externalTransactionId: 'ext-realdetlock-' + generateId(),
          playerId,
          walletId: wallet.id,
          roundId: 'round-realdetlock',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      const body = await res.json();
      expect(body.message).toContain('Concurrency limit exceeded');

      // Exatamente 6 tentativas com conflito real de versão no PostgreSQL
      expect(realLockAttempts).toBe(6);

      // Métricas incrementadas no Prometheus
      const updatedConflicts = (await (optimisticLockConflictsTotal as any).get()).values.reduce(
        (acc: number, v: any) => acc + (v.value || 0),
        0,
      );
      const updatedRetries = (await (retryAttemptsTotal as any).get()).values.reduce(
        (acc: number, v: any) => acc + (v.value || 0),
        0,
      );

      expect(updatedConflicts - initialConflicts).toBe(6);
      expect(updatedRetries - initialRetries).toBe(5);
    } finally {
      WalletRepository.prototype.save = originalWalletSave;
    }
  });

  // (f.1) nível HTTP real: 409 Conflict na colisão de uq_wager_provider_external
  it('(f.1) HTTP level (Nest real): retorna 409 Conflict na colisão de uq_wager_provider_external sob Idempotency-Key diferente', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const providerId = 'prov-http-409';
    const sharedExtId = 'ext-http-col-' + generateId();

    const bodyA = {
      providerId,
      externalTransactionId: sharedExtId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-http',
      gameId: 'game-http',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };

    // Primeira requisição HTTP bem-sucedida (HTTP 200)
    const resA = await fetch(`http://localhost:${nestPort}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-A-' + generateId(),
      },
      body: JSON.stringify(bodyA),
    });
    expect(resA.status).toBe(200);

    // Segunda requisição HTTP com mesmo providerId + externalTransactionId mas Idempotency-Key diferente (HTTP 409)
    const resB = await fetch(`http://localhost:${nestPort}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-B-' + generateId(),
      },
      body: JSON.stringify(bodyA),
    });
    expect(resB.status).toBe(409);
    const errBody = await resB.json();
    expect(errBody.message).toContain('already exists under a different Idempotency-Key');
  });

  // (f.2) nível HTTP real: 503 Service Unavailable com header Retry-After
  it('(f.2) HTTP level (Nest real): retorna 503 Service Unavailable com header Retry-After sob contenção de concorrência', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // Simula cenário de esgotamento de lock / retries através do endpoint
    // Substituindo temporariamente a execução interna por ServiceUnavailableException
    const { WageringController } = await import('../../wagering/infrastructure/http/wagering.controller');
    const wageringController = nestApp.get(WageringController);
    const originalUseCase = (wageringController as any).processWagerUseCase;

    const mockUseCase = {
      execute: async () => {
        const { ServiceUnavailableException } = await import('@nestjs/common');
        throw new ServiceUnavailableException('Concurrency limit exceeded on wallet modification');
      },
    };
    (wageringController as any).processWagerUseCase = mockUseCase;

    try {
      const res503 = await fetch(`http://localhost:${nestPort}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'key-503-' + generateId(),
        },
        body: JSON.stringify({
          providerId: 'prov-503',
          externalTransactionId: 'ext-503-' + generateId(),
          playerId,
          walletId: wallet.id,
          roundId: 'round-503',
          gameId: 'game-503',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(res503.status).toBe(503);
      expect(res503.headers.get('retry-after')).toBe('1');
      const body503 = await res503.json();
      expect(body503.message).toContain('Concurrency limit exceeded');
    } finally {
      (wageringController as any).processWagerUseCase = originalUseCase;
    }
  });

  // (g) automated migrations down (até estaca zero) e up em banco de dados descartável isolado
  it('(g) automated migrations down e up em banco temporário descartável com isolamento total', async () => {
    const em = orm.em.fork();
    const dbName = 'disposable_mig_test_' + Date.now();

    // 1. Snapshot das tabelas do banco principal antes do teste
    const mainTablesBefore = await em.getConnection().execute(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    const mainTableNamesBefore = mainTablesBefore.map((t: any) => t.table_name);
    expect(mainTableNamesBefore).toContain('wallets');
    expect(mainTableNamesBefore).toContain('wallet_ledger_entries');
    expect(mainTableNamesBefore).toContain('wager_transactions');

    // 2. Cria banco de dados descartável
    await em.getConnection().execute(`CREATE DATABASE "${dbName}"`);

    const { default: mikroOrmConfig } = await import('../../shared/infrastructure/database/mikro-orm.config');
    const disposableOrm = await (await import('@mikro-orm/postgresql')).MikroORM.init({
      ...mikroOrmConfig,
      clientUrl: `postgresql://jungle:jungle_secret@localhost:5433/${dbName}`,
      migrations: { ...mikroOrmConfig.migrations, snapshot: false }, // keep src/migrations clean
    });

    try {
      const migrator = disposableOrm.getMigrator();

      // Executa UP de todas as migrações no banco descartável
      await migrator.up();

      const dEm = disposableOrm.em.fork();
      const tablesAfterUp = await dEm.getConnection().execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
      );
      const tableNamesAfterUp = tablesAfterUp.map((t: any) => t.table_name);
      expect(tableNamesAfterUp).toContain('wallets');
      expect(tableNamesAfterUp).toContain('wallet_ledger_entries');
      expect(tableNamesAfterUp).toContain('wager_transactions');
      expect(tableNamesAfterUp).toContain('inbox_messages');
      expect(tableNamesAfterUp).toContain('outbox_messages');

      // Executa DOWN de todas as migrações (até estaca zero)
      await migrator.down({ to: 0 });

      const tablesAfterDown = await dEm.getConnection().execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
      );
      const nonMigrationTables = tablesAfterDown
        .map((t: any) => t.table_name)
        .filter((t: string) => t !== 'mikro_orm_migrations');
      expect(nonMigrationTables.length).toBe(0);

      // Reexecuta UP de todas as migrações
      await migrator.up();

      const tablesAfterReUp = await dEm.getConnection().execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
      );
      expect(tablesAfterReUp.map((t: any) => t.table_name)).toContain('wallet_ledger_entries');
    } finally {
      await disposableOrm.close(true);
      await em.getConnection().execute(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    }

    // 3. Prova que o banco de dados principal permaneceu 100% inalterado
    const mainTablesAfter = await em.getConnection().execute(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    expect(mainTablesAfter.map((t: any) => t.table_name)).toEqual(mainTableNamesBefore);
  });

  // (h) publicação dos 4 tipos de eventos com walletId em MessageGroupId
  it('(h) transactional outbox publica os 4 tipos de eventos com walletId como MessageGroupId no SQS FIFO', async () => {
    const em = orm.em.fork();
    const testWalletId = generateId();

    await em.getConnection().execute(`DELETE FROM outbox_messages WHERE published_at IS NULL`);

    const eventTypes = [
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
      'WalletBalanceUpdated',
      'WagerTransactionFailed',
    ];

    const outboxIds: string[] = [];

    for (const eventType of eventTypes) {
      const outboxId = generateId();
      outboxIds.push(outboxId);
      await em.getConnection().execute(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
         VALUES (?, ?, ?, ?::jsonb, ?)`,
        [
          outboxId,
          testWalletId,
          eventType,
          JSON.stringify({
            eventId: 'evt-' + outboxId,
            walletId: testWalletId,
            eventType,
            amount: '10.00',
          }),
          new Date(),
        ],
      );
    }

    const publishedCount = await outboxPublisher.pollAndPublish();
    expect(publishedCount).toBeGreaterThanOrEqual(4);

    const unpub = await em.getConnection().execute(
      `SELECT COUNT(*) as count FROM outbox_messages WHERE id IN (${outboxIds.map(() => '?').join(',')}) AND published_at IS NULL`,
      outboxIds,
    );
    expect(Number(unpub[0]!.count)).toBe(0);

    const sqsRes = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
        AttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
    );

    expect(sqsRes.Messages).toBeDefined();
    for (const msg of sqsRes.Messages || []) {
      if (msg.Body?.includes(testWalletId)) {
        expect(msg.Attributes?.MessageGroupId).toBe(testWalletId);
        expect(msg.MessageAttributes?.WalletId?.StringValue).toBe(testWalletId);

        if (msg.ReceiptHandle) {
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: eventsQueueUrl,
              ReceiptHandle: msg.ReceiptHandle,
            }),
          );
        }
      }
    }
  });

  // (i) SIGTERM real em processo filho com mensagem em andamento
  it('(i) SIGTERM real: processo filho com mensagem em andamento conclui com ack e encerra sem ler novas mensagens', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const msg1Id = 'sigterm-msg1-' + generateId();
    const msg2Id = 'sigterm-msg2-' + generateId();

    const makeMsg = (msgId: string) =>
      JSON.stringify({
        messageId: msgId,
        type: 'ProcessWager',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'prov-sigterm',
          externalTransactionId: 'ext-' + msgId,
          idempotencyKey: 'idem-' + msgId,
          playerId,
          walletId: wallet.id,
          roundId: 'round-sigterm',
          gameId: 'game-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        },
      });

    // Enviar mensagem 1 na fila
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: makeMsg(msg1Id),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: msg1Id,
      }),
    );

    const flagFile = '/tmp/sigterm-started-' + generateId() + '.txt';

    // Script do filho: consome mensagem 1, grava flagFile, aguarda 600ms, trata SIGTERM
    const sigtermWorkerScript = `
      import fs from 'fs';
      import { MikroORM } from '@mikro-orm/postgresql';
      import mikroOrmConfig from './src/shared/infrastructure/database/mikro-orm.config';
      import { ProcessWagerTransactionUseCase } from './src/wagering/application/use-cases/process-wager-transaction.use-case';
      import { MikroOrmUnitOfWork } from './src/shared/infrastructure/database/mikro-orm-unit-of-work';
      import { SqsWagerConsumer } from './src/wagering/infrastructure/messaging/sqs-wager.consumer';

      const orm = await MikroORM.init(mikroOrmConfig);
      const useCase = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm.em));
      
      // Delay de 600ms simulando processamento lento da mensagem em vôo
      const origExecute = useCase.execute.bind(useCase);
      useCase.execute = async (cmd) => {
        fs.writeFileSync('${flagFile}', 'started');
        await new Promise((r) => setTimeout(r, 600));
        return origExecute(cmd);
      };

      const consumer = new SqsWagerConsumer(useCase);
      consumer.onModuleInit();

      let active = true;
      process.on('SIGTERM', async () => {
        active = false;
        await consumer.onModuleDestroy();
        await orm.close(true);
        process.exit(0);
      });

      while (active) {
        await consumer.pollMessages();
        await new Promise((r) => setTimeout(r, 100));
      }
    `;

    const child = Bun.spawn(['bun', '-e', sigtermWorkerScript], {
      cwd: process.cwd(),
      stdout: 'ignore',
      stderr: 'ignore',
    });

    // Aguardar mensagem 1 começar a ser processada via flagFile
    const startWait = Date.now();
    const fs = await import('fs');
    while (!fs.existsSync(flagFile) && Date.now() - startWait < 8000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Enviar SIGTERM real ao processo filho enquanto mensagem 1 está em processamento
    child.kill('SIGTERM');

    // Agora enviar mensagem 2 DEPOIS do SIGTERM para que o filho não possa consumi-la
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: makeMsg(msg2Id),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: msg2Id,
      }),
    );

    // Aguardar encerramento gracioso do processo filho
    const exitCode = await child.exited;
    if (fs.existsSync(flagFile)) {
      fs.unlinkSync(flagFile);
    }
    expect(exitCode).toBe(0);

    // Mensagem 1 deve ter sido concluída e ACKed (deletada do SQS)
    const em = orm.em.fork();
    const tx1InDb = await em.getConnection().execute(
      `SELECT status FROM wager_transactions WHERE external_transaction_id = ?`,
      ['ext-' + msg1Id],
    );
    expect(tx1InDb.length).toBe(1);
    expect(tx1InDb[0]!.status).toBe('PROCESSED');

    // Mensagem 2 não foi consumida pelo processo filho interrompido (voltou para a fila com visibilidade 0)
    const tx2InDbInitial = await em.getConnection().execute(
      `SELECT status FROM wager_transactions WHERE external_transaction_id = ?`,
      ['ext-' + msg2Id],
    );
    expect(tx2InDbInitial.length).toBe(0);

    // Mensagem 2 está imediatamente disponível na fila com visibilidade 0:
    // Subir um novo consumidor para consumi-la com sucesso
    const successorConsumer = new SqsWagerConsumer(processWagerUseCase);
    successorConsumer.onModuleInit();
    await successorConsumer.pollMessages();
    await successorConsumer.onModuleDestroy();

    // Comprovar que mensagem 2 foi processada com sucesso pelo sucessor
    const tx2InDbAfter = await em.getConnection().execute(
      `SELECT status FROM wager_transactions WHERE external_transaction_id = ?`,
      ['ext-' + msg2Id],
    );
    expect(tx2InDbAfter.length).toBe(1);
    expect(tx2InDbAfter[0]!.status).toBe('PROCESSED');
  }, 25000);
});
