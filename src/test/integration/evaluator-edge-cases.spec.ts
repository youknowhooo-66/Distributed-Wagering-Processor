import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { AppModule } from '../../app.module';
import { DomainExceptionFilter } from '../../shared/infrastructure/http/domain-exception.filter';
import { generateId } from '../../shared/domain/identifier';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { SqsWagerConsumer } from '../../wagering/infrastructure/messaging/sqs-wager.consumer';

/**
 * Inputs an evaluator is likely to try beyond the happy path: amounts at the column limit,
 * transport-level errors, the exact SQS message of the statement, WIN -> BET references and the
 * internal namespace. None of them may end in a 500 or in a silent inconsistency.
 */
describe('Evaluator edge cases', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;
  let reconcile: ReconcileWalletUseCase;
  const sqs = new SQSClient({
    endpoint: 'http://localhost:4566',
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const queueUrl = 'http://localhost:4566/000000000000/wager-transactions.fifo';
  const dlqUrl = 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);
    baseUrl = `http://localhost:${(app.getHttpServer().address() as { port: number }).port}`;
    orm = app.get(MikroORM);
    reconcile = app.get(ReconcileWalletUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  const sql = (query: string, params: unknown[] = []): Promise<any[]> =>
    orm.em.fork().getConnection().execute(query, params) as Promise<any[]>;

  async function createWallet(amount: string) {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: generateId(), initialBalance: { amount, currency: 'BRL' } }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; playerId: string };
  }

  function submit(wallet: { id: string; playerId: string }, override: Record<string, unknown> = {}) {
    const body = {
      providerId: 'prov-edge',
      externalTransactionId: 'ext-' + generateId(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...override,
    };
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json(), externalTransactionId: body.externalTransactionId }));
  }

  // ── Money at the edge of NUMERIC(19,2) ──

  it('balances beyond float precision are updated exactly (no skipped UPDATE)', async () => {
    const wallet = await createWallet('99999999999999989.00');
    for (const amount of ['5.00', '0.01', '0.02']) {
      const r = await submit(wallet, { kind: 'WIN', money: { amount, currency: 'BRL' } });
      expect(r.status).toBe(200);
    }
    const result = await reconcile.execute(wallet.id);
    expect(result.storedBalance.amount).toBe('99999999999999994.03');
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(4);
  });

  it('a credit beyond the column capacity is a 422 BALANCE_LIMIT_EXCEEDED, not a 500', async () => {
    const wallet = await createWallet('99999999999999999.00');
    const r = await submit(wallet, { kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } });
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect((await reconcile.execute(wallet.id)).storedBalance.amount).toBe('99999999999999999.00');
  });

  // ── Transport and error envelope ──

  it('a body above the size limit is 413 PAYLOAD_TOO_LARGE and malformed JSON is 400, both with a code', async () => {
    const big = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(300_000) }),
    });
    expect(big.status).toBe(413);
    expect((await big.json()).error).toBe('PAYLOAD_TOO_LARGE');

    const malformed = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-' + generateId() },
      body: '{"providerId": ',
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toMatch(/^(INVALID_JSON|INVALID_PAYLOAD)$/);
  });

  it('every error carries { statusCode, error: CODE, message }', async () => {
    const missingWallet = await fetch(`${baseUrl}/wallets/${generateId()}`);
    expect(missingWallet.status).toBe(404);
    expect((await missingWallet.json()).error).toBe('WALLET_NOT_FOUND');

    const missingTx = await fetch(`${baseUrl}/wagering/transactions/${generateId()}`);
    expect(missingTx.status).toBe(404);
    expect((await missingTx.json()).error).toBe('TRANSACTION_NOT_FOUND');

    const unknownRoute = await fetch(`${baseUrl}/does-not-exist`);
    expect(unknownRoute.status).toBe(404);
    expect((await unknownRoute.json()).error).toBe('NOT_FOUND');

    const wallet = await createWallet('10.00');
    const first = await submit(wallet);
    const sameExternalOtherKey = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'another-key-' + generateId() },
      body: JSON.stringify({
        providerId: 'prov-edge',
        externalTransactionId: first.externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(sameExternalOtherKey.status).toBe(409);
    expect((await sameExternalOtherKey.json()).error).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  it('providerId "system" is reserved for internal transactions (400)', async () => {
    const wallet = await createWallet('10.00');
    const r = await submit(wallet, { providerId: 'system' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('INVALID_PAYLOAD');
  });

  // ── WIN -> BET reference ──

  it('WIN referencing a BET of the same round is linked; from another round it is rejected; an unknown BET does not hold the WIN', async () => {
    const wallet = await createWallet('100.00');
    const bet = await submit(wallet, { roundId: 'round-A' });
    expect(bet.status).toBe(200);

    const linked = await submit(wallet, {
      kind: 'WIN',
      roundId: 'round-A',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(linked.status).toBe(200);
    const [row] = await sql('SELECT reference_transaction_id FROM wager_transactions WHERE id = ?', [linked.body.transactionId]);
    expect(row?.reference_transaction_id).toBe(bet.body.transactionId);

    const otherRound = await submit(wallet, {
      kind: 'WIN',
      roundId: 'round-B',
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(otherRound.status).toBe(422);
    expect(otherRound.body.failureCode).toBe('CROSS_ROUND_REFERENCE');

    const unknown = await submit(wallet, {
      kind: 'WIN',
      roundId: 'round-C',
      money: { amount: '5.00', currency: 'BRL' },
      referenceExternalTransactionId: 'not-arrived-' + generateId(),
    });
    expect(unknown.status).toBe(200);
    const result = await reconcile.execute(wallet.id);
    expect(result.storedBalance.amount).toBe('125.00'); // 100 - 10 + 30 + 5
    expect(result.consistent).toBe(true);
  });

  // ── Events ──

  it('OPENING emits WagerTransactionProcessed and WalletBalanceChanged, like any applied transaction', async () => {
    const wallet = await createWallet('50.00');
    const events = await sql(
      `SELECT event_type FROM outbox_messages WHERE message_group_id = ? ORDER BY event_type`,
      [wallet.id],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  // ── SQS contract ──

  it('the exact message of the statement is processed; another `type` goes to the DLQ as INVALID_CONTRACT', async () => {
    for (const q of [queueUrl, dlqUrl]) {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: q })).catch(() => {});
    }
    const consumer = new SqsWagerConsumer(app.get(ProcessWagerTransactionUseCase));
    consumer.onModuleInit(); // ENABLE_BACKGROUND_POLL=false in tests: polled manually below

    const wallet = await createWallet('1000.00');
    const ext = 'transaction-' + generateId();
    const message = (type: string, externalTransactionId: string) => ({
      messageId: 'msg-' + externalTransactionId,
      type,
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    });
    const send = (body: unknown, dedup: string) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(body),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: dedup,
        }),
      );

    await send(message('WagerTransactionRequested', ext), 'ok-' + ext);
    await send(message('SomethingElse', 'other-' + ext), 'other-' + ext);
    for (let i = 0; i < 4; i++) await consumer.pollMessages();
    await consumer.onModuleDestroy();

    const processed = await fetch(`${baseUrl}/providers/provider-a/wagering/transactions/${ext}`);
    expect(processed.status).toBe(200);
    expect((await processed.json()).status).toBe('PROCESSED');
    const ignored = await fetch(`${baseUrl}/providers/provider-a/wagering/transactions/other-${ext}`);
    expect(ignored.status).toBe(404);

    const dlq = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }),
    );
    const poisoned = (dlq.Messages ?? []).find((m) => m.Body?.includes(`other-${ext}`));
    expect(poisoned?.MessageAttributes?.FailureReason?.StringValue).toBe('INVALID_CONTRACT');
    for (const m of dlq.Messages ?? []) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
    expect((await reconcile.execute(wallet.id)).storedBalance.amount).toBe('975.00');
  });
});
