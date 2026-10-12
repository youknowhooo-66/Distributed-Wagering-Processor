import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../shared/infrastructure/database/mikro-orm.config';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { GetWalletLedgerUseCase } from '../../wallet/application/use-cases/get-wallet-ledger.use-case';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from '../../wagering/application/use-cases/retry-pending-references.use-case';
import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository';
import { WagerTransactionRepository } from '../../wagering/infrastructure/persistence/wager-transaction.repository';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction.entity';
import { FailureCode } from '../../shared/domain/errors';
import { generateId } from '../../shared/domain/identifier';

describe('Concurrency Tests — Real Parallelism & Distributed Invariants', () => {
  let orm: MikroORM;
  let openWalletUseCase: OpenWalletUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let getWalletLedgerUseCase: GetWalletLedgerUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let retryPendingRefUseCase: RetryPendingReferencesUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    const walletRepo = new WalletRepository(orm.em);
    const wagerRepo = new WagerTransactionRepository(orm.em);

    openWalletUseCase = new OpenWalletUseCase(new MikroOrmUnitOfWork(orm.em));
    reconcileWalletUseCase = new ReconcileWalletUseCase(walletRepo);
    getWalletLedgerUseCase = new GetWalletLedgerUseCase(walletRepo);
    processWagerUseCase = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm.em));
    retryPendingRefUseCase = new RetryPendingReferencesUseCase(new MikroOrmUnitOfWork(orm.em), processWagerUseCase);
  });

  afterAll(async () => {
    await orm.close();
  });

  it('MANDATORY SCENARIO (Section 8): 100.00 BRL balance, two 80.00 BRL bets processed simultaneously', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const bet1 = {
      providerId: 'provider-concurrency',
      externalTransactionId: `concurrent-bet-1-${generateId()}`,
      idempotencyKey: `idem-bet-1-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-race-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    };

    const bet2 = {
      providerId: 'provider-concurrency',
      externalTransactionId: `concurrent-bet-2-${generateId()}`,
      idempotencyKey: `idem-bet-2-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-race-2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    };

    // Execute concurrently using real Promise.all parallelism
    const [res1, res2] = await Promise.all([
      processWagerUseCase.execute(bet1),
      processWagerUseCase.execute(bet2),
    ]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(WagerTransactionStatus.Processed);
    expect(statuses).toContain(WagerTransactionStatus.Rejected);

    const processed = res1.status === WagerTransactionStatus.Processed ? res1 : res2;
    const rejected = res1.status === WagerTransactionStatus.Rejected ? res1 : res2;

    expect(processed.status).toBe(WagerTransactionStatus.Processed);
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);

    // Final balance MUST be exactly 20.00 BRL
    const reconciliation = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('20.00');
    expect(reconciliation.calculatedBalance.amount).toBe('20.00');

    // Exactly one DEBIT in the ledger (+ 1 OPENING credit)
    const ledger = await getWalletLedgerUseCase.execute(wallet.id);
    const debitEntries = ledger.entries.filter((e) => e.direction === 'DEBIT');
    expect(debitEntries.length).toBe(1);
    expect(debitEntries[0]?.money.amount).toBe('80.00');
  });

  it('IDEMPOTENCY UNDER HIGH CONCURRENCY: 50 simultaneous identical requests cause exactly 1 debit', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '200.00', currency: 'BRL' },
    });

    const singleKey = `identical-key-${generateId()}`;
    const singleExtId = `identical-ext-${generateId()}`;
    const payload = {
      providerId: 'provider-concurrency',
      externalTransactionId: singleExtId,
      idempotencyKey: singleKey,
      playerId,
      walletId: wallet.id,
      roundId: 'round-idem-50',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    };

    // Dispatch 50 identical requests concurrently
    const promises = Array.from({ length: 50 }, () =>
      processWagerUseCase.execute(payload),
    );
    const results = await Promise.all(promises);

    // All must succeed (either processed or idempotent replay)
    for (const r of results) {
      expect(r.status).toBe(WagerTransactionStatus.Processed);
      expect(r.balance?.amount).toBe('150.00');
    }

    // Exactly one non-replay, 49 replays
    const initialTxs = results.filter((r) => !r.idempotentReplay);
    const replayTxs = results.filter((r) => r.idempotentReplay);

    expect(initialTxs.length).toBe(1);
    expect(replayTxs.length).toBe(49);

    // Ledger must have only 1 debit entry (+ opening credit)
    const ledger = await getWalletLedgerUseCase.execute(wallet.id);
    const debits = ledger.entries.filter((e) => e.direction === 'DEBIT');
    expect(debits.length).toBe(1);

    // Balance invariant
    const reconciliation = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('150.00');
  });

  it('OUT-OF-ORDER REFERENCE: REFUND arrives before BET, resolves when BET arrives', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '300.00', currency: 'BRL' },
    });

    const futureBetExtId = `bet-delayed-${generateId()}`;
    const refundExtId = `refund-early-${generateId()}`;

    // 1. REFUND arrives first! (Reference does not exist yet)
    const earlyRefundRes = await processWagerUseCase.execute({
      providerId: 'provider-concurrency',
      externalTransactionId: refundExtId,
      idempotencyKey: `key-refund-early-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-out-of-order',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '60.00', currency: 'BRL' },
      referenceExternalTransactionId: futureBetExtId,
    });

    expect(earlyRefundRes.status).toBe(WagerTransactionStatus.PendingReference);

    // 2. The referenced BET finally arrives!
    const betRes = await processWagerUseCase.execute({
      providerId: 'provider-concurrency',
      externalTransactionId: futureBetExtId,
      idempotencyKey: `key-bet-delayed-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-out-of-order',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '60.00', currency: 'BRL' },
    });
    expect(betRes.status).toBe(WagerTransactionStatus.Processed);

    // 3. Background worker triggers resolution of pending references
    const resolved = await retryPendingRefUseCase.execute(new Date(Date.now() + 5000));
    expect(resolved).toBeGreaterThanOrEqual(1);

    // Final balance check: 300 - 60 (bet) + 60 (refund) = 300.00
    const reconciliation = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('300.00');
    expect(reconciliation.calculatedBalance.amount).toBe('300.00');
  });

  it('P0.2: CONCURRENT REVERSALS: two simultaneous ROLLBACKs and two simultaneous REFUNDs on the same reference', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '500.00', currency: 'BRL' },
    });

    // 1. Process initial BET
    const betExtId = `bet-for-reversal-${generateId()}`;
    const betRes = await processWagerUseCase.execute({
      providerId: 'provider-concurrency',
      externalTransactionId: betExtId,
      idempotencyKey: `idem-bet-rev-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-rev-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '100.00', currency: 'BRL' },
    });
    expect(betRes.status).toBe(WagerTransactionStatus.Processed);

    // 2. Dispatch two simultaneous ROLLBACKs on the same BET reference
    const rollback1 = {
      providerId: 'provider-concurrency',
      externalTransactionId: `rollback-1-${generateId()}`,
      idempotencyKey: `idem-rollback-1-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-rev-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '100.00', currency: 'BRL' },
      referenceExternalTransactionId: betExtId,
    };
    const rollback2 = {
      providerId: 'provider-concurrency',
      externalTransactionId: `rollback-2-${generateId()}`,
      idempotencyKey: `idem-rollback-2-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-rev-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '100.00', currency: 'BRL' },
      referenceExternalTransactionId: betExtId,
    };

    const [rbRes1, rbRes2] = await Promise.all([
      processWagerUseCase.execute(rollback1),
      processWagerUseCase.execute(rollback2),
    ]);

    const rbStatuses = [rbRes1.status, rbRes2.status];
    expect(rbStatuses).toContain(WagerTransactionStatus.Processed);
    expect(rbStatuses).toContain(WagerTransactionStatus.Rejected);

    const rbRejected = rbRes1.status === WagerTransactionStatus.Rejected ? rbRes1 : rbRes2;
    expect(rbRejected.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    // Ledger check: exactly 1 OPENING, 1 DEBIT (bet), 1 CREDIT (rollback)
    let ledger = await getWalletLedgerUseCase.execute(wallet.id);
    let rollbackEntries = ledger.entries.filter(
      (e) => e.direction === 'CREDIT' && e.money.amount === '100.00',
    );
    expect(rollbackEntries.length).toBe(1);

    // 3. Now test two simultaneous REFUNDs on a separate BET reference
    const bet2ExtId = `bet2-for-refund-${generateId()}`;
    await processWagerUseCase.execute({
      providerId: 'provider-concurrency',
      externalTransactionId: bet2ExtId,
      idempotencyKey: `idem-bet2-rev-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-rev-2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    const refund1 = {
      providerId: 'provider-concurrency',
      externalTransactionId: `refund-1-${generateId()}`,
      idempotencyKey: `idem-refund-1-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-rev-2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: bet2ExtId,
    };
    const refund2 = {
      providerId: 'provider-concurrency',
      externalTransactionId: `refund-2-${generateId()}`,
      idempotencyKey: `idem-refund-2-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-rev-2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: bet2ExtId,
    };

    const [rfRes1, rfRes2] = await Promise.all([
      processWagerUseCase.execute(refund1),
      processWagerUseCase.execute(refund2),
    ]);

    const rfStatuses = [rfRes1.status, rfRes2.status];
    expect(rfStatuses).toContain(WagerTransactionStatus.Processed);
    expect(rfStatuses).toContain(WagerTransactionStatus.Rejected);

    const rfRejected = rfRes1.status === WagerTransactionStatus.Rejected ? rfRes1 : rfRes2;
    expect(rfRejected.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    // Check final reconciliation
    const reconciliation = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('500.00');
    expect(reconciliation.calculatedBalance.amount).toBe('500.00');
  });

  it('CONCURRENCY ACROSS DISTINCT WALLETS: concurrent bets on separate wallets do not block each other', async () => {
    const p1 = generateId();
    const p2 = generateId();
    const p3 = generateId();

    const [w1, w2, w3] = await Promise.all([
      openWalletUseCase.execute({ playerId: p1, initialBalance: { amount: '100.00', currency: 'BRL' } }),
      openWalletUseCase.execute({ playerId: p2, initialBalance: { amount: '100.00', currency: 'BRL' } }),
      openWalletUseCase.execute({ playerId: p3, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    ]);

    const [r1, r2, r3] = await Promise.all([
      processWagerUseCase.execute({
        providerId: 'provider-p1',
        externalTransactionId: `bet-p1-${generateId()}`,
        idempotencyKey: `idem-p1-${generateId()}`,
        playerId: p1,
        walletId: w1.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      }),
      processWagerUseCase.execute({
        providerId: 'provider-p2',
        externalTransactionId: `bet-p2-${generateId()}`,
        idempotencyKey: `idem-p2-${generateId()}`,
        playerId: p2,
        walletId: w2.id,
        roundId: 'round-2',
        gameId: 'game-2',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'BRL' },
      }),
      processWagerUseCase.execute({
        providerId: 'provider-p3',
        externalTransactionId: `bet-p3-${generateId()}`,
        idempotencyKey: `idem-p3-${generateId()}`,
        playerId: p3,
        walletId: w3.id,
        roundId: 'round-3',
        gameId: 'game-3',
        kind: WagerTransactionKind.Bet,
        money: { amount: '30.00', currency: 'BRL' },
      }),
    ]);

    expect(r1.status).toBe(WagerTransactionStatus.Processed);
    expect(r2.status).toBe(WagerTransactionStatus.Processed);
    expect(r3.status).toBe(WagerTransactionStatus.Processed);

    const [rec1, rec2, rec3] = await Promise.all([
      reconcileWalletUseCase.execute(w1.id),
      reconcileWalletUseCase.execute(w2.id),
      reconcileWalletUseCase.execute(w3.id),
    ]);

    expect(rec1.consistent).toBe(true);
    expect(rec1.storedBalance.amount).toBe('90.00');
    expect(rec2.consistent).toBe(true);
    expect(rec2.storedBalance.amount).toBe('80.00');
    expect(rec3.consistent).toBe(true);
    expect(rec3.storedBalance.amount).toBe('70.00');
  });
});
