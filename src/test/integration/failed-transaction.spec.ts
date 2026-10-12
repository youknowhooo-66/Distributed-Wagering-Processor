import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.entity';
import { FailureCode } from '../../shared/domain/errors/failure-codes';
import { generateId } from '../../shared/domain/identifier';
import { MikroORM } from '@mikro-orm/postgresql';
import { wagersFailedTotal } from '../../shared/infrastructure/metrics/metrics.controller';

describe('Permanent Failure — FAILED Status, Outbox Event & Metric Verification', () => {
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

  it('records FAILED status, persists WagerTransactionFailed in outbox, and increments wagering_transactions_failed_total', async () => {
    // 1. Create wallet
    const server = app.getHttpServer();
    const port = (server.address() as any).port;
    const playerId = generateId();

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

    // 2. Query initial metric count
    const initialMetricCount = (await (wagersFailedTotal as any).get()).values.reduce(
      (acc: number, v: any) => acc + (v.value || 0),
      0,
    );

    // 3. Trigger permanent failure via recordFailure
    const extTxId = 'ext-failed-' + generateId();
    const idemKey = 'key-failed-' + generateId();

    const result = await useCase.recordFailure(
      {
        providerId: 'prov-permanent-err',
        externalTransactionId: extTxId,
        idempotencyKey: idemKey,
        playerId,
        walletId: wallet.id,
        roundId: 'round-fail',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'BRL' },
        sqsMessageId: 'sqs-fail-msg-' + generateId(),
        consumerName: 'wager-transactions-consumer',
      },
      FailureCode.PERMANENT_PROCESSING_ERROR,
    );

    expect(result.status).toBe(WagerTransactionStatus.Failed);
    expect(result.failureCode).toBe(FailureCode.PERMANENT_PROCESSING_ERROR);

    // 4. Verify in PostgreSQL
    const em = orm.em.fork();

    // Verify wager_transactions table has FAILED record
    const txRows = await em.getConnection().execute(
      'SELECT id, status, failure_code FROM wager_transactions WHERE external_transaction_id = ?',
      [extTxId],
    );
    expect(txRows.length).toBe(1);
    expect(txRows[0]!.status).toBe('FAILED');
    expect(txRows[0]!.failure_code).toBe('PERMANENT_PROCESSING_ERROR');

    // Verify outbox_messages table has WagerTransactionFailed event
    const outboxRows = await em.getConnection().execute(
      "SELECT id, aggregate_id, event_type, payload FROM outbox_messages WHERE event_type = 'WagerTransactionFailed' AND aggregate_id = ?",
      [txRows[0]!.id],
    );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]!.event_type).toBe('WagerTransactionFailed');
    const eventPayload =
      typeof outboxRows[0]!.payload === 'string'
        ? JSON.parse(outboxRows[0]!.payload)
        : outboxRows[0]!.payload;
    expect(eventPayload.data.failureCode).toBe('PERMANENT_PROCESSING_ERROR');
    expect(eventPayload.data.status).toBe('FAILED');

    // 5. Verify Prometheus metric wagering_transactions_failed_total was incremented
    const updatedMetricCount = (await (wagersFailedTotal as any).get()).values.reduce(
      (acc: number, v: any) => acc + (v.value || 0),
      0,
    );
    expect(updatedMetricCount).toBeGreaterThan(initialMetricCount);
  });
});
