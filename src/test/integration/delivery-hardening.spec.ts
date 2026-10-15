import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../app.module';
import { DomainExceptionFilter } from '../../shared/infrastructure/http/domain-exception.filter';
import { generateId } from '../../shared/domain/identifier';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from '../../wagering/application/use-cases/retry-pending-references.use-case';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.entity';
import { FailureCode } from '../../shared/domain/errors';

/**
 * Contract and invariant hardening: mandatory Idempotency-Key, correlation id propagation,
 * 400 for malformed ids/cursors, wallet ownership, FAILED mapping, chained out-of-order
 * reversals, and the database guards that make balance/ledger/transaction rules hold even
 * for writes that bypass the application.
 */
describe('Delivery hardening — HTTP contract, domain edge cases and database guards', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;
  let processWager: ProcessWagerTransactionUseCase;
  let retryPending: RetryPendingReferencesUseCase;
  let reconcile: ReconcileWalletUseCase;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);
    baseUrl = `http://localhost:${(app.getHttpServer().address() as { port: number }).port}`;
    orm = app.get(MikroORM);
    processWager = app.get(ProcessWagerTransactionUseCase);
    retryPending = app.get(RetryPendingReferencesUseCase);
    reconcile = app.get(ReconcileWalletUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  const sql = (query: string, params: unknown[] = []): Promise<any[]> =>
    orm.em.fork().getConnection().execute(query, params) as Promise<any[]>;

  async function createWallet(amount = '100.00') {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: generateId(), initialBalance: { amount, currency: 'BRL' } }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; playerId: string };
  }

  function wager(wallet: { id: string; playerId: string }, override: Record<string, unknown> = {}) {
    const externalTransactionId = 'ext-' + generateId();
    return {
      providerId: 'prov-hardening',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...override,
    };
  }

  function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  // ── HTTP contract ────────────────────────────────────────────────────────

  it('400 MISSING_IDEMPOTENCY_KEY when the header is absent or blank (header is mandatory)', async () => {
    const wallet = await createWallet();
    for (const headers of [{}, { 'Idempotency-Key': '   ' }] as Record<string, string>[]) {
      const res = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(wager(wallet)),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('MISSING_IDEMPOTENCY_KEY');
    }
    const ledger = await (await fetch(`${baseUrl}/wallets/${wallet.id}/ledger`)).json();
    expect(ledger.entries).toHaveLength(1); // only the opening credit
  });

  it('echoes X-Correlation-Id and propagates it to the integration events', async () => {
    const wallet = await createWallet();
    const correlationId = 'corr-' + generateId();
    const res = await post(wager(wallet), { 'X-Correlation-Id': correlationId });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toBe(correlationId);
    const { transactionId } = await res.json();

    const rows = await sql(
      `SELECT event_type, payload->>'correlationId' AS correlation_id
         FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY event_type`,
      [transactionId],
    );
    expect(rows.map((r: any) => r.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(rows.every((r: any) => r.correlation_id === correlationId)).toBe(true);

    // Without the header a correlation id is generated and still returned
    const generated = (await post(wager(wallet))).headers.get('x-correlation-id');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['GET', '/wallets/not-a-uuid'],
    ['GET', '/wallets/not-a-uuid/ledger'],
    ['POST', '/wallets/not-a-uuid/reconciliation'],
    ['GET', '/wagering/transactions/not-a-uuid'],
  ])('400 INVALID_ID for %s %s (never a database cast error)', async (method, path) => {
    const res = await fetch(`${baseUrl}${path}`, { method });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('INVALID_ID');
  });

  it('400 INVALID_LIMIT / INVALID_CURSOR on the ledger', async () => {
    const wallet = await createWallet();
    for (const limit of ['0', 'abc', '201', '-5']) {
      const res = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=${limit}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('INVALID_LIMIT');
    }
    const res = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?cursor=bm90LWEtY3Vyc29y`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('INVALID_CURSOR');
  });

  it('ledger cursor is stable: pages never skip or repeat entries while new movements arrive', async () => {
    const wallet = await createWallet('100.00');
    for (let i = 0; i < 4; i++) expect((await post(wager(wallet))).status).toBe(200);

    const page1 = await (await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=2`)).json();
    expect(page1.entries.map((e: any) => e.walletVersion)).toEqual([5, 4]);

    // A movement committed between page requests only shows up on a fresh first page
    expect((await post(wager(wallet))).status).toBe(200);

    const page2 = await (await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=2&cursor=${page1.nextCursor}`)).json();
    const page3 = await (await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=2&cursor=${page2.nextCursor}`)).json();
    expect(page2.entries.map((e: any) => e.walletVersion)).toEqual([3, 2]);
    expect(page3.entries.map((e: any) => e.walletVersion)).toEqual([1]);
    expect(page3.nextCursor).toBeNull();
    // Each entry continues the previous one
    const chain = [...page1.entries, ...page2.entries, ...page3.entries];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(chain[i].balanceBefore.amount).toBe(chain[i + 1].balanceAfter.amount);
    }
  });

  it('POST /wallets: 400 for an invalid body, and concurrent creation for the same player yields one 201 and 409s', async () => {
    const bad = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'nope', initialBalance: { amount: 10, currency: 'BRL' } }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('INVALID_PAYLOAD');

    const playerId = generateId();
    const statuses = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${baseUrl}/wallets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId, initialBalance: { amount: '50.00', currency: 'BRL' } }),
        }).then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    const rows = await sql('SELECT COUNT(*)::int AS count FROM wallets WHERE player_id = ?', [playerId]);
    expect(rows[0]?.count).toBe(1);
  });

  it('422 WALLET_PLAYER_MISMATCH when the wallet belongs to another player (no money moves)', async () => {
    const wallet = await createWallet('100.00');
    const res = await post(wager({ id: wallet.id, playerId: generateId() }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe(FailureCode.WALLET_PLAYER_MISMATCH);
    expect(body.balance.amount).toBe('100.00');
    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
  });

  it('a FAILED transaction replays as 500 with its status and failureCode (terminal, never re-applied)', async () => {
    const wallet = await createWallet('100.00');
    const body = wager(wallet);
    const idempotencyKey = `${body.providerId}:${body.externalTransactionId}`;
    await processWager.recordFailure({ ...(body as any), idempotencyKey }, FailureCode.PERMANENT_PROCESSING_ERROR);

    const res = await post(body);
    expect(res.status).toBe(500);
    const result = await res.json();
    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe(FailureCode.PERMANENT_PROCESSING_ERROR);
    expect(result.idempotentReplay).toBe(true);
    expect((await reconcile.execute(wallet.id)).storedBalance.amount).toBe('100.00');
  });

  // ── Out-of-order chains ──────────────────────────────────────────────────

  async function drainPending(ids: string[]) {
    // Other suites may leave due items in the shared queue; iterate with a clock far ahead
    for (let i = 0; i < 15; i++) {
      const rows = await sql(
        `SELECT COUNT(*)::int AS count FROM wager_transactions WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'PENDING_REFERENCE'`,
        ids,
      );
      if (rows[0]?.count === 0) return;
      // Each round one hour later than the previous: every backoff (max 300s) has elapsed
      await retryPending.execute(new Date(Date.now() + 3_600_000 * (i + 1)));
    }
  }

  it('ROLLBACK(REFUND) -> REFUND(BET) -> BET arriving fully reversed all end PROCESSED (reversal waits for a waiting reference)', async () => {
    const wallet = await createWallet('100.00');
    const betExt = 'bet-' + generateId();
    const refundExt = 'refund-' + generateId();
    const rollbackExt = 'rollback-' + generateId();
    const base = { providerId: 'prov-chain', playerId: wallet.playerId, walletId: wallet.id, roundId: 'r-chain', gameId: 'g', money: { amount: '10.00', currency: 'BRL' } };
    const cmd = (externalTransactionId: string, kind: WagerTransactionKind, ref?: string) => ({
      ...base,
      externalTransactionId,
      idempotencyKey: `prov-chain:${externalTransactionId}`,
      kind,
      referenceExternalTransactionId: ref,
    });

    const rollback = await processWager.execute(cmd(rollbackExt, WagerTransactionKind.Rollback, refundExt));
    const refund = await processWager.execute(cmd(refundExt, WagerTransactionKind.Refund, betExt));
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    // REFUND exists but waits: the ROLLBACK keeps waiting instead of REFERENCE_NOT_PROCESSED
    const rollbackAgain = await processWager.execute(cmd(rollbackExt, WagerTransactionKind.Rollback, refundExt));
    expect(rollbackAgain.status).toBe(WagerTransactionStatus.PendingReference);
    expect(rollbackAgain.idempotentReplay).toBe(true);

    const bet = await processWager.execute(cmd(betExt, WagerTransactionKind.Bet));
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    await drainPending([rollback.transactionId, refund.transactionId]);

    const statuses = await sql(
      'SELECT kind, status FROM wager_transactions WHERE id IN (?, ?, ?) ORDER BY kind',
      [bet.transactionId, refund.transactionId, rollback.transactionId],
    );
    expect(statuses).toEqual([
      { kind: 'BET', status: 'PROCESSED' },
      { kind: 'REFUND', status: 'PROCESSED' },
      { kind: 'ROLLBACK', status: 'PROCESSED' },
    ]);
    const result = await reconcile.execute(wallet.id);
    expect(result.storedBalance.amount).toBe('90.00'); // 100 - 10 (BET) + 10 (REFUND) - 10 (ROLLBACK of REFUND)
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(4);
  });

  it('an identical resend of a waiting transaction is a replay: no new event, no extra retry consumed', async () => {
    const wallet = await createWallet('100.00');
    const ext = 'refund-' + generateId();
    const command = {
      providerId: 'prov-resend',
      externalTransactionId: ext,
      idempotencyKey: `prov-resend:${ext}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Refund,
      money: { amount: '5.00', currency: 'BRL' },
      referenceExternalTransactionId: 'never-' + generateId(),
    };
    const first = await processWager.execute(command);
    const second = await processWager.execute(command);
    expect(first.idempotentReplay).toBe(false);
    expect(second).toMatchObject({ transactionId: first.transactionId, status: 'PENDING_REFERENCE', idempotentReplay: true });

    const [row] = await sql(
      `SELECT retry_count,
              (SELECT COUNT(*)::int FROM outbox_messages WHERE aggregate_id = t.id AND event_type = 'WagerTransactionPendingReference') AS events
         FROM wager_transactions t WHERE id = ?`,
      [first.transactionId],
    );
    expect(row).toEqual({ retry_count: 1, events: 1 });
    // close it so it does not linger in the shared pending batch
    await sql(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'REFERENCE_TIMEOUT', processed_at = NOW() WHERE id = ?`, [first.transactionId]);
  });

  it('an SQS message that ends PENDING_REFERENCE is recorded in the inbox (redelivery is deduplicated)', async () => {
    const wallet = await createWallet('100.00');
    const ext = 'refund-' + generateId();
    const messageId = 'msg-' + generateId();
    const command = {
      providerId: 'prov-inbox-pending',
      externalTransactionId: ext,
      idempotencyKey: `prov-inbox-pending:${ext}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Refund,
      money: { amount: '5.00', currency: 'BRL' },
      referenceExternalTransactionId: 'never-' + generateId(),
      sqsMessageId: messageId,
      consumerName: 'test-consumer',
    };
    const result = await processWager.execute(command);
    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    const inbox = await sql('SELECT processed_at FROM inbox_messages WHERE consumer_name = ? AND message_id = ?', [
      'test-consumer',
      messageId,
    ]);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.processed_at).not.toBeNull();
    await sql(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'REFERENCE_TIMEOUT', processed_at = NOW() WHERE id = ?`, [result.transactionId]);
  });

  // ── Database guards (restriction 9: rules hold even for writes that bypass the app) ──

  /** Runs `work` in a transaction that is always rolled back (also if a guard is missing). */
  async function inRolledBackTx(work: (em: any) => Promise<void>): Promise<void> {
    const sentinel = new Error('forced rollback');
    try {
      await orm.em.fork().transactional(async (em) => {
        await work(em);
        throw sentinel;
      });
    } catch (err) {
      if (err === sentinel) throw new Error('expected the database to refuse the write, but it was accepted');
      throw err;
    }
  }

  async function processedBet() {
    const wallet = await createWallet('100.00');
    const res = await post(wager(wallet));
    const { transactionId } = await res.json();
    return { wallet, transactionId };
  }

  it('a terminal transaction cannot change, and business columns are immutable', async () => {
    const { transactionId } = await processedBet();
    await expect(
      sql(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_BALANCE' WHERE id = ?`, [transactionId]),
    ).rejects.toThrow('is terminal');
    await expect(sql('UPDATE wager_transactions SET amount = 1.00 WHERE id = ?', [transactionId])).rejects.toThrow(
      'is terminal',
    );
  });

  it('transactions and ledger entries cannot be deleted or truncated', async () => {
    const { transactionId } = await processedBet();
    await expect(inRolledBackTx((em) => em.execute('DELETE FROM wager_transactions WHERE id = ?', [transactionId]))).rejects.toThrow(
      'append-only',
    );
    await expect(inRolledBackTx((em) => em.execute('TRUNCATE wager_transactions CASCADE'))).rejects.toThrow(
      'TRUNCATE is prohibited',
    );
    await expect(inRolledBackTx((em) => em.execute('TRUNCATE wallet_ledger_entries'))).rejects.toThrow(
      'TRUNCATE is prohibited',
    );
  });

  it('PostgreSQL refuses a balance change without its ledger entry, and a version bump without a balance change', async () => {
    const { wallet } = await processedBet();
    await expect(
      orm.em.fork().transactional((em) =>
        em.execute('UPDATE wallets SET balance_amount = balance_amount + 1, version = version + 1 WHERE id = ?', [wallet.id]),
      ),
    ).rejects.toThrow('has no matching ledger entry');
    await expect(
      orm.em.fork().transactional((em) => em.execute('UPDATE wallets SET version = version + 1 WHERE id = ?', [wallet.id])),
    ).rejects.toThrow('changed without a balance change');
    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
  });

  it('PostgreSQL refuses a ledger entry that is not the movement of its wallet', async () => {
    const { wallet, transactionId } = await processedBet();
    // A copy of the processed BET (so the ledger x transaction check passes) with an entry that
    // claims the next version without the wallet moving
    const cloneId = generateId();
    await expect(
      orm.em.fork().transactional(async (em) => {
        await em.execute(
          `INSERT INTO wager_transactions
             SELECT (jsonb_populate_record(t, jsonb_build_object(
                      'id', ?::text, 'external_transaction_id', 'clone-' || ?::text, 'idempotency_key', 'clone-' || ?::text))).*
               FROM wager_transactions t WHERE t.id = ?`,
          [cloneId, cloneId, cloneId, transactionId],
        );
        await em.execute(
          `INSERT INTO wallet_ledger_entries
             (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
           SELECT ?, w.id, ?, 'DEBIT', 10.00, 'BRL', w.balance_amount, w.balance_amount - 10.00, w.version + 1, NOW()
             FROM wallets w WHERE w.id = ?`,
          [generateId(), cloneId, wallet.id],
        );
      }),
    ).rejects.toThrow('does not match the state of wallet');
    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
  });
});
