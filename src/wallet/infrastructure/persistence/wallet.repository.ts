import { Injectable } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import type { WalletRepositoryPort } from '../../domain/wallet.repository.port';
import { Wallet } from '../../domain/wallet.entity';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/wallet-ledger-entry.entity';
import { WalletMikroEntity } from './wallet.mikro-entity';
import { WalletLedgerEntryMikroEntity } from './wallet-ledger-entry.mikro-entity';

@Injectable()
export class WalletRepository implements WalletRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string, lockMode?: LockMode): Promise<Wallet | null> {
    const entity = await this.em.findOne(
      WalletMikroEntity,
      { id },
      lockMode ? { lockMode } : undefined,
    );
    if (!entity) return null;

    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balanceAmount: entity.balanceAmount,
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  findByIdForUpdate(id: string): Promise<Wallet | null> {
    return this.findById(id, LockMode.PESSIMISTIC_WRITE);
  }

  async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletMikroEntity, { playerId, currency });
    if (!entity) return null;

    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balanceAmount: entity.balanceAmount,
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  async save(wallet: Wallet): Promise<void> {
    let entity = await this.em.findOne(WalletMikroEntity, { id: wallet.id });
    if (!entity) {
      entity = new WalletMikroEntity();
      entity.id = wallet.id;
      entity.playerId = wallet.playerId;
      entity.currency = wallet.currency;
      entity.balanceAmount = wallet.balance.amount;
      entity.version = wallet.version;
      entity.createdAt = wallet.createdAt;
      entity.updatedAt = wallet.updatedAt;
      this.em.persist(entity);
    } else {
      entity.balanceAmount = wallet.balance.amount;
      entity.updatedAt = wallet.updatedAt;
    }
  }

  async saveLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    const entity = new WalletLedgerEntryMikroEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amount = entry.money.amount;
    entity.currency = entry.money.currency;
    entity.balanceBefore = entry.balanceBefore.amount;
    entity.balanceAfter = entry.balanceAfter.amount;
    entity.walletVersion = entry.walletVersion;
    entity.createdAt = entry.createdAt;

    this.em.persist(entity);
  }

  async findLedgerEntries(
    walletId: string,
    limit: number,
    beforeVersion?: number,
  ): Promise<WalletLedgerEntry[]> {
    // walletVersion is unique and gap-free per wallet (uq_ledger_wallet_version), so the order is
    // total and new entries never shift an existing page: a stable keyset cursor
    const entities = await this.em.find(
      WalletLedgerEntryMikroEntity,
      beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: beforeVersion } },
      { orderBy: { walletVersion: 'DESC' }, limit },
    );

    return entities.map((e) =>
      WalletLedgerEntry.rehydrate({
        id: e.id,
        walletId: e.walletId,
        transactionId: e.transactionId,
        direction: e.direction as LedgerDirection,
        moneyAmount: e.amount,
        moneyCurrency: e.currency,
        balanceBeforeAmount: e.balanceBefore,
        balanceBeforeCurrency: e.currency,
        balanceAfterAmount: e.balanceAfter,
        balanceAfterCurrency: e.currency,
        walletVersion: e.walletVersion,
        createdAt: e.createdAt,
      }),
    );
  }

  async sumLedgerBalance(walletId: string): Promise<string> {
    // Computes SUM(CREDIT) - SUM(DEBIT)
    const conn = this.em.getConnection();
    const result = await conn.execute<{ balance: string }[]>(
      `SELECT COALESCE(SUM(
        CASE 
          WHEN direction = 'CREDIT' THEN amount 
          WHEN direction = 'DEBIT' THEN -amount 
          ELSE 0 
        END
      ), 0)::NUMERIC(19,2) as balance 
      FROM wallet_ledger_entries 
      WHERE wallet_id = ?`,
      [walletId],
    );

    return result[0]?.balance ?? '0.00';
  }

  async countLedgerEntries(walletId: string): Promise<number> {
    return this.em.count(WalletLedgerEntryMikroEntity, { walletId });
  }

  async countLedgerTransactionMismatches(walletId: string): Promise<number> {
    const conn = this.em.getConnection();
    const result = await conn.execute<{ mismatches: string }[]>(
      `SELECT
         (SELECT COUNT(*)
            FROM wallet_ledger_entries l
            LEFT JOIN wager_transactions t ON t.id = l.transaction_id
           WHERE l.wallet_id = ?
             AND (t.id IS NULL
                  OR t.status <> 'PROCESSED'
                  OR t.wallet_id <> l.wallet_id
                  OR t.amount <> l.amount
                  OR t.currency <> l.currency
                  OR (t.kind = 'BET' AND l.direction <> 'DEBIT')
                  OR (t.kind IN ('WIN', 'REFUND', 'OPENING') AND l.direction <> 'CREDIT')
                  OR t.kind = 'LOSS'))
       + (SELECT COUNT(*)
            FROM wager_transactions t
           WHERE t.wallet_id = ?
             AND t.status = 'PROCESSED'
             AND t.kind <> 'LOSS'
             AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries l
                              WHERE l.wallet_id = t.wallet_id AND l.transaction_id = t.id))
         AS mismatches`,
      [walletId, walletId],
    );
    return Number(result[0]?.mismatches ?? 0);
  }
}
