import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.entity';
import { generateId } from '../../shared/domain/identifier';
import { MikroORM } from '@mikro-orm/postgresql';

describe('Logical Consumer Inbox Deduplication — Multi-Replica Guarantee', () => {
  let app: INestApplication;
  let useCase: ProcessWagerTransactionUseCase;
  let orm: MikroORM;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    useCase = app.get(ProcessWagerTransactionUseCase);
    orm = app.get(MikroORM);
  });

  afterAll(async () => {
    await app.close();
  });

  it('two consumer replicas receiving identical message (same messageId) produce 1 business effect and 1 inbox row', async () => {
    // 1. Create wallet via HTTP
    const server = app.getHttpServer();
    const port = (server.address() as any).port || 3000;
    const playerId = generateId();

    const em = orm.em.fork();
    const walletRes = await fetch(`http://localhost:${port}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    const wallet = await walletRes.json();
    expect(wallet.id).toBeDefined();

    // 2. Setup common message parameters
    const sharedMsgId = 'sqs-shared-msg-' + generateId();
    const sharedExtTxId = 'ext-dedup-' + generateId();
    const sharedIdemKey = 'idem-dedup-' + generateId();
    const logicalConsumerName = 'wager-transactions-consumer';

    const command = {
      providerId: 'prov-dedup',
      externalTransactionId: sharedExtTxId,
      idempotencyKey: sharedIdemKey,
      playerId,
      walletId: wallet.id,
      roundId: 'round-dedup',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
      sqsMessageId: sharedMsgId,
      consumerName: logicalConsumerName,
    };

    // 3. Replica 1 receives and processes message
    const res1 = await useCase.execute(command);
    expect(res1.status).toBe(WagerTransactionStatus.Processed);
    expect(res1.idempotentReplay).toBeFalsy();

    // 4. Replica 2 receives the exact same message (e.g. SQS duplicate delivery or redelivery)
    const res2 = await useCase.execute(command);
    expect(res2.status).toBe(WagerTransactionStatus.Processed);
    expect(res2.idempotentReplay).toBe(true);

    // 5. Query PostgreSQL directly to assert exactly 1 business effect and exactly 1 inbox row
    const emCheck = orm.em.fork();

    // Verify inbox_messages has exactly 1 row
    const inboxRows = await emCheck.getConnection().execute(
      'SELECT consumer_name, message_id FROM inbox_messages WHERE message_id = ?',
      [sharedMsgId],
    );
    expect(inboxRows.length).toBe(1);
    expect(inboxRows[0]!.consumer_name).toBe(logicalConsumerName);

    // Verify wager_transactions has exactly 1 row
    const txRows = await emCheck.getConnection().execute(
      'SELECT id, status FROM wager_transactions WHERE external_transaction_id = ?',
      [sharedExtTxId],
    );
    expect(txRows.length).toBe(1);
    expect(txRows[0]!.status).toBe('PROCESSED');

    // Verify wallet_ledger_entries has exactly 2 entries (1 initial deposit + 1 debit)
    const ledgerRows = await emCheck.getConnection().execute(
      'SELECT id, direction, amount FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY created_at ASC',
      [wallet.id],
    );
    expect(ledgerRows.length).toBe(2);
    expect(ledgerRows[0]!.direction).toBe('CREDIT');
    expect(ledgerRows[0]!.amount).toBe('100.00');
    expect(ledgerRows[1]!.direction).toBe('DEBIT');
    expect(ledgerRows[1]!.amount).toBe('10.00');

    // Verify wallet balance is exactly 90.00 (debited once, not twice)
    const walletRows = await emCheck.getConnection().execute(
      'SELECT balance_amount, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(walletRows[0]!.balance_amount).toBe('90.00');
    expect(walletRows[0]!.version).toBe(2);
  });
});
