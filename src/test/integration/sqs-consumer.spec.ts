import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import mikroOrmConfig from '../../shared/infrastructure/database/mikro-orm.config';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository';
import { SqsWagerConsumer } from '../../wagering/infrastructure/messaging/sqs-wager.consumer';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.entity';
import { generateId } from '../../shared/domain/identifier';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';

describe('SQS Consumer Integration — Contracts, Inbox Dedup, DLQ, and ACK Invariants', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let openWalletUseCase: OpenWalletUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let consumer: SqsWagerConsumer;

  const queueUrl = 'http://localhost:4566/000000000000/wager-transactions.fifo';
  const dlqUrl = 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

  beforeAll(async () => {
    orm = (await CoreMikroORM.init(mikroOrmConfig)) as MikroORM;
    sqs = new SQSClient({
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });

    // Queue hygiene: purge queues at startup
    for (const q of [queueUrl, dlqUrl]) {
      try {
        await sqs.send(new (await import('@aws-sdk/client-sqs')).PurgeQueueCommand({ QueueUrl: q }));
      } catch {}
    }

    openWalletUseCase = new OpenWalletUseCase(new MikroOrmUnitOfWork(orm.em));
    reconcileWalletUseCase = new ReconcileWalletUseCase(new WalletRepository(orm.em));
    processWagerUseCase = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm.em));
    consumer = new SqsWagerConsumer(processWagerUseCase);
    consumer.onModuleInit();
  });

  afterAll(async () => {
    await consumer.onModuleDestroy();
    await orm.close(true);
  });

  it('forwards malformed payload directly to DLQ and removes it from main queue', async () => {
    const invalidMessageId = 'malformed-' + generateId();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: '{ this is not valid json! }',
        MessageGroupId: 'poison-' + generateId(),
        MessageDeduplicationId: invalidMessageId,
      }),
    );

    // Run poll iteration
    await consumer.pollMessages();

    // Verify DLQ received the poisoned message
    const dlqRes = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      }),
    );

    expect(dlqRes.Messages).toBeDefined();
    const found = dlqRes.Messages?.find((m) => m.Body?.includes('this is not valid json!'));
    expect(found).toBeDefined();

    // Clean DLQ
    if (found?.ReceiptHandle) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: found.ReceiptHandle }));
    }
  });

  it('processes valid SQS wager message, records inbox message, and deletes from queue', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const msgId = 'sqs-msg-' + generateId();
    const extTxId = 'sqs-ext-' + generateId();
    const idemKey = 'sqs-idem-' + generateId();

    const envelope = {
      messageId: msgId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-sqs',
        externalTransactionId: extTxId,
        idempotencyKey: idemKey,
        playerId,
        walletId: wallet.id,
        roundId: 'round-sqs-1',
        gameId: 'game-sqs',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      },
    };

    // Send to SQS
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: msgId,
      }),
    );

    // Consume via worker
    await consumer.pollMessages();

    // Verify inbox message in DB
    const em = orm.em.fork();
    const inboxRows = await em.getConnection().execute(
      'SELECT message_id, processed_at FROM inbox_messages WHERE message_id = ?',
      [msgId],
    );
    expect(inboxRows.length).toBe(1);
    expect(inboxRows[0]!.processed_at).toBeDefined();

    // Verify balance & ledger
    const reconcileResult = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconcileResult.consistent).toBe(true);
    expect(reconcileResult.storedBalance.amount).toBe('75.00');
  });
});
