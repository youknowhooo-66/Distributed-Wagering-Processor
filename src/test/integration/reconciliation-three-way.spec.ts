import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../shared/infrastructure/database/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction.entity';
import { generateId } from '../../shared/domain/identifier';

describe('Reconciliation — balance x ledger x transactions', () => {
  let orm: MikroORM;
  let openWallet: OpenWalletUseCase;
  let reconcile: ReconcileWalletUseCase;
  let processWager: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    const uow = new MikroOrmUnitOfWork(orm.em);
    openWallet = new OpenWalletUseCase(uow);
    reconcile = new ReconcileWalletUseCase(new WalletRepository(orm.em));
    processWager = new ProcessWagerTransactionUseCase(uow);
  });

  afterAll(async () => {
    await orm.close();
  });

  async function walletWithWin() {
    const playerId = generateId();
    const wallet = await openWallet.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const ext = 'win-' + generateId();
    const win = await processWager.execute({
      providerId: 'prov-recon',
      externalTransactionId: ext,
      idempotencyKey: 'prov-recon:' + ext,
      playerId,
      walletId: wallet.id,
      roundId: 'r1',
      gameId: 'g1',
      kind: WagerTransactionKind.Win,
      money: { amount: '10.00', currency: 'BRL' },
    });
    return { wallet, winId: win.transactionId };
  }

  it('is consistent for a normal history (opening + WIN)', async () => {
    const { wallet } = await walletWithWin();
    const result = await reconcile.execute(wallet.id);
    expect(result.consistent).toBe(true);
    expect(result.transactionMismatches).toBe(0);
    expect(result.storedBalance.amount).toBe('110.00');
  });

  /** P0-2 class of drift: a PROCESSED transaction of 10.00 whose ledger entry credits 500.00. */
  async function insertDrift(em: { execute: (sql: string, params?: unknown[]) => Promise<unknown> }, walletId: string, winId: string) {
    const driftTxId = generateId();
    await em.execute(
      `INSERT INTO wager_transactions
         SELECT (jsonb_populate_record(t, jsonb_build_object(
                  'id', ?::text,
                  'external_transaction_id', 'drift-' || ?::text,
                  'idempotency_key', 'drift-' || ?::text))).*
           FROM wager_transactions t WHERE t.id = ?`,
      [driftTxId, driftTxId, driftTxId, winId],
    );
    await em.execute(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 'CREDIT', 500.00, 'BRL', 110.00, 610.00, NOW())`,
      [generateId(), walletId, driftTxId],
    );
    await em.execute('UPDATE wallets SET balance_amount = 610.00, version = version + 1 WHERE id = ?', [walletId]);
  }

  /** PROCESSED money-moving transaction without any ledger entry. */
  async function insertOrphan(em: { execute: (sql: string, params?: unknown[]) => Promise<unknown> }, winId: string) {
    const orphanId = generateId();
    await em.execute(
      `INSERT INTO wager_transactions
         SELECT (jsonb_populate_record(t, jsonb_build_object(
                  'id', ?::text,
                  'external_transaction_id', 'orphan-' || ?::text,
                  'idempotency_key', 'orphan-' || ?::text))).*
           FROM wager_transactions t WHERE t.id = ?`,
      [orphanId, orphanId, orphanId, winId],
    );
  }

  /** Simulates data that predates the integrity triggers (or a privileged manual fix). */
  const bypassingTriggers = (work: (em: any) => Promise<void>) =>
    orm.em.fork().transactional(async (em) => {
      await em.execute('SET LOCAL session_replication_role = replica');
      await work(em);
    });

  it('PostgreSQL refuses a ledger entry that differs from its transaction (checked at COMMIT)', async () => {
    const { wallet, winId } = await walletWithWin();
    await expect(
      orm.em.fork().transactional((em) => insertDrift(em, wallet.id, winId)),
    ).rejects.toThrow('does not match transaction');
    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
  });

  it('PostgreSQL refuses a PROCESSED money-moving transaction without a ledger entry', async () => {
    const { wallet, winId } = await walletWithWin();
    await expect(orm.em.fork().transactional((em) => insertOrphan(em, winId))).rejects.toThrow(
      'has no ledger entry',
    );
    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
  });

  it('reconciliation still detects a ledger/transaction mismatch that bypassed the triggers', async () => {
    const { wallet, winId } = await walletWithWin();
    await bypassingTriggers((em) => insertDrift(em, wallet.id, winId));

    const result = await reconcile.execute(wallet.id);
    expect(result.difference.amount).toBe('0.00'); // balance == ledger sum: a two-way check would pass
    expect(result.transactionMismatches).toBe(1);
    expect(result.consistent).toBe(false);
  });

  it('reconciliation still detects a processed transaction without ledger that bypassed the triggers', async () => {
    const { wallet, winId } = await walletWithWin();
    await bypassingTriggers((em) => insertOrphan(em, winId));

    const result = await reconcile.execute(wallet.id);
    expect(result.difference.amount).toBe('0.00');
    expect(result.transactionMismatches).toBe(1);
    expect(result.consistent).toBe(false);
  });
});
