import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from '../../wagering/application/use-cases/retry-pending-references.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.entity';
import { FailureCode } from '../../shared/domain/errors/failure-codes';
import { generateId } from '../../shared/domain/identifier';
import { MikroORM } from '@mikro-orm/postgresql';

describe('Pending Reference Dual Reversal Resolution — Invariant Verification', () => {
  let app: INestApplication;
  let processUseCase: ProcessWagerTransactionUseCase;
  let retryUseCase: RetryPendingReferencesUseCase;
  let orm: MikroORM;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    processUseCase = app.get(ProcessWagerTransactionUseCase);
    retryUseCase = app.get(RetryPendingReferencesUseCase);
    orm = app.get(MikroORM);
  });

  afterAll(async () => {
    await app.close();
  });

  it('REFUND and ROLLBACK of same BET both in PENDING_REFERENCE; when BET arrives, exactly 1 PROCESSED, 1 REJECTED (REFERENCE_ALREADY_REVERSED), exactly 1 ledger reversal credit, balance = sum(ledger)', async () => {
    const server = app.getHttpServer();
    const port = (server.address() as any).port;
    const playerId = generateId();

    // 1. Create wallet with initial deposit 200.00 BRL
    const walletRes = await fetch(`http://localhost:${port}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '200.00', currency: 'BRL' },
      }),
    });
    const wallet = await walletRes.json();
    expect(wallet.id).toBeDefined();

    const providerId = 'prov-race-reversal';
    const betExtTxId = 'bet-target-' + generateId();
    const refundExtTxId = 'refund-race-' + generateId();
    const rollbackExtTxId = 'rollback-race-' + generateId();
    const roundId = 'round-race-' + generateId();

    // 2. REFUND arrives BEFORE the BET -> enters PENDING_REFERENCE
    const refundRes = await processUseCase.execute({
      providerId,
      externalTransactionId: refundExtTxId,
      idempotencyKey: 'idem-' + refundExtTxId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: betExtTxId,
    });
    expect(refundRes.status).toBe(WagerTransactionStatus.PendingReference);

    // 3. ROLLBACK of the same BET also arrives BEFORE the BET -> enters PENDING_REFERENCE
    const rollbackRes = await processUseCase.execute({
      providerId,
      externalTransactionId: rollbackExtTxId,
      idempotencyKey: 'idem-' + rollbackExtTxId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: betExtTxId,
    });
    expect(rollbackRes.status).toBe(WagerTransactionStatus.PendingReference);

    // 4. Now the BET arrives and is processed: debits 50.00 BRL
    const betRes = await processUseCase.execute({
      providerId,
      externalTransactionId: betExtTxId,
      idempotencyKey: 'idem-' + betExtTxId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(betRes.status).toBe(WagerTransactionStatus.Processed);

    // 5. Trigger RetryPendingReferencesUseCase to resolve the pending reversals (pass date past backoff)
    // The worker batch is global (other tests may leave pending rows): drain until this
    // test's reversals settle instead of asserting on a single batch's count.
    const futureDate = new Date(Date.now() + 10_000);
    const pendingOwn = async () =>
      Number(
        (
          await orm.em
            .fork()
            .getConnection()
            .execute(
              `SELECT COUNT(*) AS c FROM wager_transactions
               WHERE external_transaction_id IN (?, ?) AND status = 'PENDING_REFERENCE'`,
              [refundExtTxId, rollbackExtTxId],
            )
        )[0]?.c,
      );
    for (let i = 0; i < 20 && (await pendingOwn()) > 0; i++) {
      await retryUseCase.execute(futureDate);
    }
    expect(await pendingOwn()).toBe(0);

    // 6. Inspect database state
    const em = orm.em.fork();

    // Verify both reversal transactions: exactly 1 PROCESSED and exactly 1 REJECTED
    const reversalTxs = await em.getConnection().execute(
      `SELECT id, kind, status, failure_code FROM wager_transactions 
       WHERE external_transaction_id IN (?, ?)`,
      [refundExtTxId, rollbackExtTxId],
    );
    expect(reversalTxs.length).toBe(2);

    const processedReversal = reversalTxs.find((t: any) => t.status === 'PROCESSED');
    const rejectedReversal = reversalTxs.find((t: any) => t.status === 'REJECTED');

    expect(processedReversal).toBeDefined();
    expect(rejectedReversal).toBeDefined();
    expect(rejectedReversal!.failure_code).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    // Verify ledger entries:
    // 1 CREDIT (200.00 opening) + 1 DEBIT (50.00 BET) + exactly 1 CREDIT (50.00 reversal) = 3 entries
    const ledgerRows = await em.getConnection().execute(
      `SELECT id, direction, amount, balance_after FROM wallet_ledger_entries 
       WHERE wallet_id = ? ORDER BY created_at ASC`,
      [wallet.id],
    );
    expect(ledgerRows.length).toBe(3);
    expect(ledgerRows[0]!.direction).toBe('CREDIT'); // 200.00
    expect(ledgerRows[1]!.direction).toBe('DEBIT');  // 50.00 bet
    expect(ledgerRows[2]!.direction).toBe('CREDIT'); // 50.00 reversal credit

    // Calculate sum of ledger
    let calculatedBalance = 0;
    for (const entry of ledgerRows) {
      if (entry.direction === 'CREDIT') {
        calculatedBalance += parseFloat(entry.amount);
      } else {
        calculatedBalance -= parseFloat(entry.amount);
      }
    }

    // Verify wallet balance equals sum of ledger entries
    const walletRow = (await em.getConnection().execute(
      'SELECT balance_amount FROM wallets WHERE id = ?',
      [wallet.id],
    ))[0];

    const currentBalance = parseFloat(walletRow!.balance_amount);
    expect(currentBalance).toBe(200.00); // 200 - 50 + 50 = 200
    expect(calculatedBalance).toBe(currentBalance);
  });
});
