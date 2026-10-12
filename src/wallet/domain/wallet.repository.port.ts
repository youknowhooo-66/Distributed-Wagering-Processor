import { Wallet } from './wallet.entity';
import { WalletLedgerEntry } from './wallet-ledger-entry.entity';

export const WALLET_REPOSITORY = Symbol('WalletRepositoryPort');

export interface WalletRepositoryPort {
  findById(id: string): Promise<Wallet | null>;
  /** Loads the wallet holding a row lock until the transaction ends (per-wallet serialization). */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
  saveLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  findLedgerEntries(walletId: string, limit: number, cursor?: { createdAt: Date; id: string }): Promise<WalletLedgerEntry[]>;
  sumLedgerBalance(walletId: string): Promise<string>;
  countLedgerEntries(walletId: string): Promise<number>;
  /**
   * Ledger entries that do not match their originating transaction (missing, not PROCESSED,
   * different wallet/amount/currency, or direction incompatible with the kind), plus
   * PROCESSED money-moving transactions without a ledger entry.
   */
  countLedgerTransactionMismatches(walletId: string): Promise<number>;
}
