import { Money } from '../../shared/domain/value-objects';
import {
  InsufficientBalanceError,
  CurrencyMismatchError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
} from '../../shared/domain/errors';
import { WalletLedgerEntry, LedgerDirection } from './wallet-ledger-entry.entity';
import { generateId } from '../../shared/domain/identifier';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Wallet Aggregate Root.
 *
 * Invariants:
 * - At most one wallet per (playerId, currency) — UNIQUE constraint in the schema
 * - Balance never negative — domain check + CHECK constraint
 * - Every balance change produces exactly one ledger entry (and vice versa) — the entry
 *   carries the version it moved the wallet to; PostgreSQL verifies the pairing at COMMIT
 * - Concurrent operations cannot cause lost updates — row lock + version check on UPDATE
 * - Operation currency must match wallet currency
 * - Version starts at 1 after creation and increments only when the balance changes
 */
export class Wallet {
  /** Largest balance a wallet can hold (the NUMERIC(19,2) column capacity). */
  static readonly MAX_BALANCE_AMOUNT = '99999999999999999.99';

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a new wallet at version 1. When the initial balance is positive the caller records
   * it through {@link openingEntry} (internal OPENING transaction) in the same SQL transaction.
   */
  static open(props: {
    id: string;
    playerId: string;
    currency: string;
    createdAt: Date;
    initialBalance?: Money;
  }): Wallet {
    const initial = props.initialBalance ?? Money.zero(props.currency);
    if (initial.currency !== props.currency) {
      throw new CurrencyMismatchError(props.currency, initial.currency);
    }
    if (initial.isNegative()) {
      throw new InvalidMoneyError('initial balance must not be negative');
    }
    return new Wallet(props.id, props.playerId, props.currency, initial, 1, props.createdAt, props.createdAt);
  }

  /**
   * Reconstructs from persistence — no re-validation of transitions.
   */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.fromInternal(state.balanceAmount, state.currency),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  // ── Getters ──

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ── Mutations (return the ledger entry as proof of the balance change) ──

  /**
   * Ledger entry for the initial balance of a just-opened wallet (0 -> initial, version 1).
   * Only valid before any other movement and for a positive initial balance.
   */
  openingEntry(transactionId: string): WalletLedgerEntry {
    if (this._version !== 1 || !this._balance.isPositive()) {
      throw new InvalidLedgerEntryError('opening entry requires a new wallet with a positive initial balance');
    }
    return WalletLedgerEntry.create({
      id: generateId(),
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      walletVersion: this._version,
      createdAt: this.createdAt,
    });
  }

  /**
   * Debits the wallet. Throws if insufficient balance.
   * Returns the corresponding ledger entry.
   */
  debit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);

    if (this._balance.isLessThan(money)) {
      throw new InsufficientBalanceError(
        this.id,
        this._balance.toString(),
        money.toString(),
      );
    }

    return this.apply(transactionId, LedgerDirection.Debit, money, this._balance.subtract(money), at);
  }

  /** Whether a credit of `money` keeps the balance within {@link MAX_BALANCE_AMOUNT}. */
  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    const max = Money.fromInternal(Wallet.MAX_BALANCE_AMOUNT, this.currency);
    return !max.isLessThan(this._balance.add(money));
  }

  /**
   * Credits the wallet. Throws if the balance would exceed {@link MAX_BALANCE_AMOUNT}.
   * Returns the corresponding ledger entry.
   */
  credit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    if (!this.canCredit(money)) {
      throw new InvalidMoneyError(`balance would exceed ${Wallet.MAX_BALANCE_AMOUNT} ${this.currency}`);
    }
    return this.apply(transactionId, LedgerDirection.Credit, money, this._balance.add(money), at);
  }

  // ── Private ──

  private apply(
    transactionId: string,
    direction: LedgerDirection,
    money: Money,
    balanceAfter: Money,
    at: Date,
  ): WalletLedgerEntry {
    // Validated before mutating: a rejected entry (e.g. zero amount) leaves the wallet untouched
    const entry = WalletLedgerEntry.create({
      id: generateId(),
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: at,
    });
    this._balance = balanceAfter;
    this._version++;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
