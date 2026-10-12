import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../app.module';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from '../../wagering/application/use-cases/retry-pending-references.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.entity';
import {
  pendingReferencesGauge,
  pendingReferencesResolved,
  reconciliationDiscrepancies,
} from '../../shared/infrastructure/metrics/metrics.controller';
import { generateId } from '../../shared/domain/identifier';

const value = async (metric: { get(): Promise<{ values: { value: number }[] }> }) =>
  (await metric.get()).values.reduce((acc, v) => acc + v.value, 0);

/** Metrics documented in the runbook must actually move when the event happens (DI-wired adapter). */
describe('Metrics wiring — pending references and reconciliation', () => {
  let app: INestApplication;
  let orm: MikroORM;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.init();
    orm = app.get(MikroORM);
  });

  afterAll(async () => {
    await app.close();
  });

  it('counts resolved pending references and exposes the current pending count', async () => {
    const playerId = generateId();
    const wallet = await app.get(OpenWalletUseCase).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const processWager = app.get(ProcessWagerTransactionUseCase);
    const base = { providerId: 'prov-metrics-wiring', playerId, walletId: wallet.id, roundId: 'r1', gameId: 'g1' };
    const betId = 'bet-' + generateId();
    const refundId = 'refund-' + generateId();

    const pending = await processWager.execute({
      ...base,
      externalTransactionId: refundId,
      idempotencyKey: 'mw:' + refundId,
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: betId,
    });
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    await processWager.execute({
      ...base,
      externalTransactionId: betId,
      idempotencyKey: 'mw:' + betId,
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });

    const resolvedBefore = await value(pendingReferencesResolved as any);
    const retry = app.get(RetryPendingReferencesUseCase);
    const isPending = async () =>
      (
        await orm.em.fork().getConnection().execute('SELECT status FROM wager_transactions WHERE id = ?', [
          pending.transactionId,
        ])
      )[0]?.status === 'PENDING_REFERENCE';
    // The worker batch is global; drain until this test's transaction settles
    for (let i = 0; i < 20 && (await isPending()); i++) {
      await retry.execute(new Date(Date.now() + 10_000));
    }
    expect(await isPending()).toBe(false);
    expect(await value(pendingReferencesResolved as any)).toBeGreaterThan(resolvedBefore);

    const dbPending = Number(
      (
        await orm.em
          .fork()
          .getConnection()
          .execute("SELECT COUNT(*) AS c FROM wager_transactions WHERE status = 'PENDING_REFERENCE'")
      )[0]?.c,
    );
    expect(await value(pendingReferencesGauge as any)).toBe(dbPending);
  });

  it('counts reconciliation discrepancies', async () => {
    const wallet = await app.get(OpenWalletUseCase).execute({
      playerId: generateId(),
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });
    // Drift the stored balance away from the ledger
    await orm.em
      .fork()
      .getConnection()
      .execute('UPDATE wallets SET balance_amount = 51.00 WHERE id = ?', [wallet.id]);

    const before = await value(reconciliationDiscrepancies as any);
    const result = await app.get(ReconcileWalletUseCase).execute(wallet.id);
    expect(result.consistent).toBe(false);
    expect(await value(reconciliationDiscrepancies as any)).toBe(before + 1);
  });
});
