import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../shared/infrastructure/database/mikro-orm.config';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { GetWalletUseCase } from '../../wallet/application/use-cases/get-wallet.use-case';
import { GetWalletLedgerUseCase } from '../../wallet/application/use-cases/get-wallet-ledger.use-case';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from '../../wagering/application/use-cases/retry-pending-references.use-case';
import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository';
import { WagerTransactionRepository } from '../../wagering/infrastructure/persistence/wager-transaction.repository';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction.entity';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry.entity';
import { FailureCode, IdempotencyConflictError } from '../../shared/domain/errors';
import { ConflictException } from '@nestjs/common';
import { generateId } from '../../shared/domain/identifier';

describe('Integration — Core Use Cases & Database Atomic Invariants', () => {
  let orm: MikroORM;
  let openWalletUseCase: OpenWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let getWalletLedgerUseCase: GetWalletLedgerUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let retryPendingRefUseCase: RetryPendingReferencesUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    const walletRepo = new WalletRepository(orm.em);
    const wagerRepo = new WagerTransactionRepository(orm.em);

    openWalletUseCase = new OpenWalletUseCase(new MikroOrmUnitOfWork(orm.em));
    getWalletUseCase = new GetWalletUseCase(walletRepo);
    getWalletLedgerUseCase = new GetWalletLedgerUseCase(walletRepo);
    reconcileWalletUseCase = new ReconcileWalletUseCase(walletRepo);
    processWagerUseCase = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm.em));
    retryPendingRefUseCase = new RetryPendingReferencesUseCase(new MikroOrmUnitOfWork(orm.em), processWagerUseCase);
  });

  afterAll(async () => {
    await orm.close();
  });

  it('opens a wallet with initial balance and verifies ledger atomicity', async () => {
    const playerId = generateId();
    const result = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    expect(result.id).toBeDefined();
    expect(result.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(result.version).toBe(1); // 1 on creation with opening balance

    // Verify ledger has opening entry
    const ledger = await getWalletLedgerUseCase.execute(result.id);
    expect(ledger.entries.length).toBe(1);
    expect(ledger.entries[0]?.direction).toBe(LedgerDirection.Credit);
    expect(ledger.entries[0]?.money).toEqual({ amount: '1000.00', currency: 'BRL' });

    // Verify reconciliation
    const reconciliation = await reconcileWalletUseCase.execute(result.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('1000.00');
    expect(reconciliation.calculatedBalance.amount).toBe('1000.00');
  });

  it('rejects duplicate wallet creation for same player and currency', async () => {
    const playerId = generateId();
    await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    expect(
      openWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('processes BET, WIN, LOSS, and maintains continuous ledger consistency', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '500.00', currency: 'BRL' },
    });

    // 1. BET 100.00
    const betRes = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: `bet-${generateId()}`,
      idempotencyKey: `test:bet-1:${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '100.00', currency: 'BRL' },
    });
    expect(betRes.status).toBe(WagerTransactionStatus.Processed);
    expect(betRes.balance?.amount).toBe('400.00');

    // 2. WIN 250.00
    const winRes = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: `win-${generateId()}`,
      idempotencyKey: `test:win-1:${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      money: { amount: '250.00', currency: 'BRL' },
    });
    expect(winRes.status).toBe(WagerTransactionStatus.Processed);
    expect(winRes.balance?.amount).toBe('650.00');

    // 3. LOSS 0.00 (records without moving balance)
    const lossRes = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: `loss-${generateId()}`,
      idempotencyKey: `test:loss-1:${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Loss,
      money: { amount: '0.00', currency: 'BRL' },
    });
    expect(lossRes.status).toBe(WagerTransactionStatus.Processed);
    expect(lossRes.balance?.amount).toBe('650.00');

    // 4. Verify Final Reconciliation
    const reconciliation = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('650.00');
    expect(reconciliation.calculatedBalance.amount).toBe('650.00');
  });

  it('processes REFUND of a BET and prevents duplicate reversal', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '200.00', currency: 'BRL' },
    });

    const betExtId = `bet-refund-${generateId()}`;

    // BET 50.00
    await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: betExtId,
      idempotencyKey: `test:bet-refund:${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-refund',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    // REFUND 50.00
    const refundRes = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: `refund-1-${generateId()}`,
      idempotencyKey: `test:refund-1:${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-refund',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: betExtId,
    });
    expect(refundRes.status).toBe(WagerTransactionStatus.Processed);
    expect(refundRes.balance?.amount).toBe('200.00'); // refunded back!

    // Second REFUND of the same BET must be rejected
    const dupRefundRes = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: `refund-2-${generateId()}`,
      idempotencyKey: `test:refund-2:${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-refund',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: betExtId,
    });
    expect(dupRefundRes.status).toBe(WagerTransactionStatus.Rejected);
    expect(dupRefundRes.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    // Ledger balance invariant
    const reconciliation = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('200.00');
  });

  it('handles idempotent replay and rejects idempotency conflict', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const key = `key-${generateId()}`;
    const extTxId = `tx-idem-${generateId()}`;
    const payload = {
      providerId: 'provider-test',
      externalTransactionId: extTxId,
      idempotencyKey: key,
      playerId,
      walletId: wallet.id,
      roundId: 'round-idem',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    };

    // First request
    const firstRes = await processWagerUseCase.execute(payload);
    expect(firstRes.status).toBe(WagerTransactionStatus.Processed);
    expect(firstRes.idempotentReplay).toBe(false);
    expect(firstRes.balance?.amount).toBe('70.00');

    // Identical replay
    const secondRes = await processWagerUseCase.execute(payload);
    expect(secondRes.transactionId).toBe(firstRes.transactionId);
    expect(secondRes.idempotentReplay).toBe(true);
    expect(secondRes.balance?.amount).toBe('70.00');

    // Conflicting payload with same key must throw IdempotencyConflictError
    expect(
      processWagerUseCase.execute({
        ...payload,
        money: { amount: '35.00', currency: 'BRL' }, // different amount!
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('enforces ledger immutability at database level by blocking UPDATE and DELETE', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const conn = orm.em.getConnection();
    const entries = await conn.execute<Array<{ id: string }>>(
      'SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? LIMIT 1',
      [wallet.id],
    );
    expect(entries.length).toBe(1);
    const entryId = entries[0]!.id;

    // Attempt direct SQL UPDATE on wallet_ledger_entries -> must fail due to trigger
    expect(
      conn.execute('UPDATE wallet_ledger_entries SET amount = 999.00 WHERE id = ?', [entryId]),
    ).rejects.toThrow(/immutable/i);

    // Attempt direct SQL DELETE on wallet_ledger_entries -> must fail due to trigger
    expect(
      conn.execute('DELETE FROM wallet_ledger_entries WHERE id = ?', [entryId]),
    ).rejects.toThrow(/immutable/i);
  });

  it('P0.3: returns historical balance observed at transaction time on idempotent replay (BET, LOSS, REJECTED)', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // 1. Process BET 30.00 -> balance becomes 70.00
    const betKey = `idem-hist-bet-${generateId()}`;
    const betExt = `ext-hist-bet-${generateId()}`;
    const betRes = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: betExt,
      idempotencyKey: betKey,
      playerId,
      walletId: wallet.id,
      roundId: 'round-hist-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(betRes.status).toBe(WagerTransactionStatus.Processed);
    expect(betRes.balance?.amount).toBe('70.00');

    // 2. Process WIN 50.00 -> balance moves to 120.00
    await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: `ext-hist-win-${generateId()}`,
      idempotencyKey: `idem-hist-win-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-hist-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    });

    // 3. Replay BET -> MUST return historical balance 70.00, NOT live balance 120.00!
    const replayBet = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: betExt,
      idempotencyKey: betKey,
      playerId,
      walletId: wallet.id,
      roundId: 'round-hist-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(replayBet.idempotentReplay).toBe(true);
    expect(replayBet.balance?.amount).toBe('70.00');

    // 4. Process LOSS 0.00 -> balance remains 120.00
    const lossKey = `idem-hist-loss-${generateId()}`;
    const lossExt = `ext-hist-loss-${generateId()}`;
    const lossRes = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: lossExt,
      idempotencyKey: lossKey,
      playerId,
      walletId: wallet.id,
      roundId: 'round-hist-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Loss,
      money: { amount: '0.00', currency: 'BRL' },
    });
    expect(lossRes.status).toBe(WagerTransactionStatus.Processed);
    expect(lossRes.balance?.amount).toBe('120.00');

    // Move live balance again via WIN 20.00 -> balance becomes 140.00
    await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: `ext-hist-win2-${generateId()}`,
      idempotencyKey: `idem-hist-win2-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-hist-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      money: { amount: '20.00', currency: 'BRL' },
    });

    // Replay LOSS -> MUST return historical balance 120.00, NOT live balance 140.00!
    const replayLoss = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: lossExt,
      idempotencyKey: lossKey,
      playerId,
      walletId: wallet.id,
      roundId: 'round-hist-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Loss,
      money: { amount: '0.00', currency: 'BRL' },
    });
    expect(replayLoss.idempotentReplay).toBe(true);
    expect(replayLoss.balance?.amount).toBe('120.00');

    // 5. Submit BET 9999.00 -> REJECTED (Insufficient balance, balance recorded as 140.00)
    const rejKey = `idem-hist-rej-${generateId()}`;
    const rejExt = `ext-hist-rej-${generateId()}`;
    const rejRes = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: rejExt,
      idempotencyKey: rejKey,
      playerId,
      walletId: wallet.id,
      roundId: 'round-hist-3',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '9999.00', currency: 'BRL' },
    });
    expect(rejRes.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejRes.balance?.amount).toBe('140.00');

    // Move live balance again via WIN 60.00 -> balance becomes 200.00
    await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: `ext-hist-win3-${generateId()}`,
      idempotencyKey: `idem-hist-win3-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-hist-3',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      money: { amount: '60.00', currency: 'BRL' },
    });

    // Replay REJECTED -> MUST return historical balance 140.00, NOT live balance 200.00!
    const replayRej = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: rejExt,
      idempotencyKey: rejKey,
      playerId,
      walletId: wallet.id,
      roundId: 'round-hist-3',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '9999.00', currency: 'BRL' },
    });
    expect(replayRej.idempotentReplay).toBe(true);
    expect(replayRej.status).toBe(WagerTransactionStatus.Rejected);
    expect(replayRej.balance?.amount).toBe('140.00');
  });

  it('P0.4: processes pending references concurrently without duplicate processing', async () => {
    const playerId = generateId();
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '500.00', currency: 'BRL' },
    });

    const betExt1 = `bet-worker-1-${generateId()}`;
    const betExt2 = `bet-worker-2-${generateId()}`;

    // 1. Submit 2 out-of-order refunds
    const refund1 = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: `ref-w1-${generateId()}`,
      idempotencyKey: `key-ref-w1-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-w1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: betExt1,
    });

    const refund2 = await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: `ref-w2-${generateId()}`,
      idempotencyKey: `key-ref-w2-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-w2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: betExt2,
    });

    // 2. Now submit both referenced bets
    await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: betExt1,
      idempotencyKey: `key-bet-w1-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-w1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    await processWagerUseCase.execute({
      providerId: 'provider-test',
      externalTransactionId: betExt2,
      idempotencyKey: `key-bet-w2-${generateId()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-w2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    // 3. Run two workers concurrently. The worker batch is global (other tests may leave
    // pending rows), so assert on this test's own transactions and drain until they settle.
    const ownIds = [refund1.transactionId, refund2.transactionId];
    const ownStatuses = async () =>
      (await orm.em
        .fork()
        .getConnection()
        .execute('SELECT status FROM wager_transactions WHERE id IN (?, ?)', ownIds)) as { status: string }[];
    await Promise.all([
      retryPendingRefUseCase.execute(new Date(Date.now() + 5000)),
      retryPendingRefUseCase.execute(new Date(Date.now() + 5000)),
    ]);
    for (let i = 0; i < 20 && (await ownStatuses()).some((r) => r.status === 'PENDING_REFERENCE'); i++) {
      await Promise.all([
        retryPendingRefUseCase.execute(new Date(Date.now() + 5000)),
        retryPendingRefUseCase.execute(new Date(Date.now() + 5000)),
      ]);
    }

    // Each refund processed exactly once (a duplicate would credit twice and break the balance)
    expect((await ownStatuses()).map((r) => r.status)).toEqual(['PROCESSED', 'PROCESSED']);

    const reconciliation = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('500.00');
  });
});


