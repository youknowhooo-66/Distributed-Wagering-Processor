import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../shared/infrastructure/database/mikro-orm.config';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from '../../wagering/application/use-cases/retry-pending-references.use-case';
import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository';
import { WagerTransactionRepository } from '../../wagering/infrastructure/persistence/wager-transaction.repository';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction.entity';
import { IdempotencyConflictError } from '../../shared/domain/errors';
import { generateId } from '../../shared/domain/identifier';

describe('Idempotency — PENDING_REFERENCE resend with divergent payload', () => {
  let orm: MikroORM;
  let openWallet: OpenWalletUseCase;
  let reconcile: ReconcileWalletUseCase;
  let processWager: ProcessWagerTransactionUseCase;
  let retryPending: RetryPendingReferencesUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    const walletRepo = new WalletRepository(orm.em);
    const wagerRepo = new WagerTransactionRepository(orm.em);
    openWallet = new OpenWalletUseCase(new MikroOrmUnitOfWork(orm.em));
    reconcile = new ReconcileWalletUseCase(walletRepo);
    processWager = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm.em));
    retryPending = new RetryPendingReferencesUseCase(new MikroOrmUnitOfWork(orm.em), processWager);
  });

  afterAll(async () => {
    // The 'not-yet-arrived' references never resolve: remove them so they do not
    // occupy the global pending-reference worker batch in later tests
    await orm.em
      .fork()
      .getConnection()
      .execute(
        "DELETE FROM wager_transactions WHERE provider_id = 'provider-idem' AND status = 'PENDING_REFERENCE'",
      );
    await orm.close();
  });

  async function setup() {
    const playerId = generateId();
    const wallet = await openWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const base = {
      providerId: 'provider-idem',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
    };
    const betId = generateId();
    await processWager.execute({
      ...base,
      externalTransactionId: betId,
      idempotencyKey: `provider-idem:${betId}`,
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });
    const refundId = generateId();
    const pendingCmd = {
      ...base,
      externalTransactionId: refundId,
      idempotencyKey: `provider-idem:${refundId}`,
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'not-yet-arrived',
    };
    const pending = await processWager.execute(pendingCmd);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    return { wallet, betId, pendingCmd };
  }

  async function storedBalance(walletId: string): Promise<string> {
    const rows = await orm.em
      .fork()
      .getConnection()
      .execute('SELECT balance_amount FROM wallets WHERE id = ?', [walletId]);
    return String(rows[0]?.balance_amount);
  }

  it('rejects a resend with a different amount and reference (409) and leaves the balance untouched', async () => {
    const { wallet, betId, pendingCmd } = await setup();

    await expect(
      processWager.execute({
        ...pendingCmd,
        money: { amount: '500.00', currency: 'BRL' },
        referenceExternalTransactionId: betId,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await storedBalance(wallet.id)).toBe('90.00');
    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
  });

  it('rejects a resend that only swaps the reference (409)', async () => {
    const { wallet, betId, pendingCmd } = await setup();

    await expect(
      processWager.execute({ ...pendingCmd, referenceExternalTransactionId: betId }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await storedBalance(wallet.id)).toBe('90.00');
  });

  it('an identical resend stays PENDING_REFERENCE and does not move money', async () => {
    const { wallet, pendingCmd } = await setup();

    const replay = await processWager.execute(pendingCmd);
    expect(replay.status).toBe(WagerTransactionStatus.PendingReference);
    expect(await storedBalance(wallet.id)).toBe('90.00');
  });

  it('the pending-reference worker still resolves with the persisted payload', async () => {
    const { wallet } = await setup();
    const refundId = generateId();

    // A REFUND arriving before its BET must be resolved later by the worker
    const lateBetId = generateId();
    const refundCmd = {
      providerId: 'provider-idem',
      externalTransactionId: refundId,
      idempotencyKey: `provider-idem:${refundId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: { amount: '5.00', currency: 'BRL' },
      referenceExternalTransactionId: lateBetId,
    };
    expect((await processWager.execute(refundCmd)).status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    await processWager.execute({
      ...refundCmd,
      externalTransactionId: lateBetId,
      idempotencyKey: `provider-idem:${lateBetId}`,
      kind: WagerTransactionKind.Bet,
      referenceExternalTransactionId: undefined,
    });
    expect(await storedBalance(wallet.id)).toBe('85.00');

    // Force the pending tx to be due now, then run the worker
    await orm.em
      .fork()
      .getConnection()
      .execute(
        "UPDATE wager_transactions SET next_retry_at = NOW() - INTERVAL '1 second' WHERE idempotency_key = ?",
        [refundCmd.idempotencyKey],
      );
    await retryPending.execute(new Date(Date.now() + 1000));

    expect(await storedBalance(wallet.id)).toBe('90.00');
    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
  });
});
