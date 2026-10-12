import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import mikroOrmConfig from '../../shared/infrastructure/database/mikro-orm.config';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { GetWalletLedgerUseCase } from '../../wallet/application/use-cases/get-wallet-ledger.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.entity';
import { generateId } from '../../shared/domain/identifier';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { PrometheusWageringMetrics } from '../../shared/infrastructure/metrics/prometheus-wagering-metrics';

import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository';
import { optimisticLockConflictsTotal, retryAttemptsTotal } from '../../shared/infrastructure/metrics/metrics.controller';

describe('Load Test — 50 Distinct Concurrent Bets on Single Wallet', () => {
  let orm: MikroORM;
  let openWalletUseCase: OpenWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let getWalletLedgerUseCase: GetWalletLedgerUseCase;

  beforeAll(async () => {
    orm = (await CoreMikroORM.init(mikroOrmConfig)) as MikroORM;
    openWalletUseCase = new OpenWalletUseCase(new MikroOrmUnitOfWork(orm.em));
    // Prometheus adapter wired explicitly: this test asserts on conflict/retry counters
    processWagerUseCase = new ProcessWagerTransactionUseCase(
      new MikroOrmUnitOfWork(orm.em),
      new PrometheusWageringMetrics(),
    );
    reconcileWalletUseCase = new ReconcileWalletUseCase(new WalletRepository(orm.em));
    getWalletLedgerUseCase = new GetWalletLedgerUseCase(new WalletRepository(orm.em));
  });

  afterAll(async () => {
    await orm.close(true);
  });

  async function runConcurrentBets(count: number, initialBalanceAmount: string = '50000.00') {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: initialBalanceAmount, currency: 'BRL' },
    });

    const latencies: number[] = [];
    const outcomes: { status: string; statusCode?: number; err?: string }[] = [];

    const tasks = Array.from({ length: count }, (_, i) => {
      const extId = `distinct-bet-${count}-${i}-${generateId()}`;
      const idemKey = `idem-${count}-${i}-${generateId()}`;
      return async () => {
        const start = performance.now();
        try {
          const res = await processWagerUseCase.execute({
            providerId: 'provider-load-test',
            externalTransactionId: extId,
            idempotencyKey: idemKey,
            playerId,
            walletId: wallet.id,
            roundId: `round-${count}-${i}`,
            gameId: 'game-load-test',
            kind: WagerTransactionKind.Bet,
            money: { amount: '10.00', currency: 'BRL' },
          });
          latencies.push(performance.now() - start);
          outcomes.push({ status: res.status });
        } catch (err: any) {
          latencies.push(performance.now() - start);
          outcomes.push({
            status: 'ERROR',
            statusCode: err.status || 500,
            err: err.message,
          });
        }
      };
    });

    await Promise.all(tasks.map((t) => t()));

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
    const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;

    const processedCount = outcomes.filter((o) => o.status === WagerTransactionStatus.Processed).length;
    const error503Count = outcomes.filter(
      (o) => o.status === 'ERROR' && (o.statusCode === 503 || o.err?.includes('Concurrency limit exceeded')),
    ).length;

    const expectedBalance = (parseFloat(initialBalanceAmount) - processedCount * 10).toFixed(2);
    const ledger = await getWalletLedgerUseCase.execute(wallet.id);
    const reconcileResult = await reconcileWalletUseCase.execute(wallet.id);

    return {
      wallet,
      count,
      processedCount,
      error503Count,
      p50,
      p95,
      p99,
      expectedBalance,
      ledger,
      reconcileResult,
    };
  }

  it('executes 50 distinct bets simultaneously: verifies PROCESSED vs 503, p50/p95/p99 latency, and strict ledger balance', async () => {
    const res = await runConcurrentBets(50, '5000.00');

    console.log(
      `[LOAD TEST METRICS] Total: 50 | PROCESSED: ${res.processedCount} | 503 Concurrency Exceeded: ${res.error503Count} | p50: ${res.p50.toFixed(2)}ms | p95: ${res.p95.toFixed(2)}ms | p99: ${res.p99.toFixed(2)}ms`,
    );

    expect(res.processedCount).toBe(50);
    expect(res.error503Count).toBe(0);
    expect(res.reconcileResult.consistent).toBe(true);
    expect(res.reconcileResult.calculatedBalance.amount).toBe(res.expectedBalance);
    expect(res.reconcileResult.storedBalance.amount).toBe(res.expectedBalance);
  });

  it('executes 30 consecutive rounds of 50 simultaneous bets on same wallet: 50/50 PROCESSED in 30/30 rounds', async () => {
    const playerId = generateId();
    // 30 rounds * 50 bets * 10.00 = 15000.00 BRL
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '20000.00', currency: 'BRL' },
    });

    for (let round = 1; round <= 30; round++) {
      const tasks = Array.from({ length: 50 }, (_, i) => {
        const extId = `round-${round}-bet-${i}-${generateId()}`;
        const idemKey = `idem-r${round}-${i}-${generateId()}`;
        return processWagerUseCase.execute({
          providerId: 'provider-load-test',
          externalTransactionId: extId,
          idempotencyKey: idemKey,
          playerId,
          walletId: wallet.id,
          roundId: `round-${round}`,
          gameId: 'game-load-test',
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        });
      });

      const results = await Promise.all(tasks);
      const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed).length;
      expect(processed).toBe(50);
    }

    const reconcileResult = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconcileResult.consistent).toBe(true);
    // 20000 - 30 * 50 * 10 = 5000.00
    expect(reconcileResult.storedBalance.amount).toBe('5000.00');
    expect(reconcileResult.calculatedBalance.amount).toBe('5000.00');
  });

  it('executes 100 simultaneous bets on single wallet: 100% processed without 503', async () => {
    const res = await runConcurrentBets(100, '10000.00');
    console.log(
      `[LOAD TEST 100 BETS] Total: 100 | PROCESSED: ${res.processedCount} | 503: ${res.error503Count} | p50: ${res.p50.toFixed(2)}ms | p95: ${res.p95.toFixed(2)}ms`,
    );
    expect(res.processedCount).toBe(100);
    expect(res.error503Count).toBe(0);
    expect(res.reconcileResult.consistent).toBe(true);
    expect(res.reconcileResult.storedBalance.amount).toBe(res.expectedBalance);
  });

  it('executes 200 simultaneous bets on single wallet: 100% processed without 503', async () => {
    const res = await runConcurrentBets(200, '20000.00');
    console.log(
      `[LOAD TEST 200 BETS] Total: 200 | PROCESSED: ${res.processedCount} | 503: ${res.error503Count} | p50: ${res.p50.toFixed(2)}ms | p95: ${res.p95.toFixed(2)}ms`,
    );
    expect(res.processedCount).toBe(200);
    expect(res.error503Count).toBe(0);
    expect(res.reconcileResult.consistent).toBe(true);
    expect(res.reconcileResult.storedBalance.amount).toBe(res.expectedBalance);
  });
});
