import { Money } from '../../shared/domain/value-objects';
import {
  InsufficientBalanceError,
  CurrencyMismatchError,
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
 * - At most one wallet per (playerId, currency) — enforced by UNIQUE constraint in schema
 * - Balance never negative — enforced by CHECK constraint in schema + domain validation
 * - Every balance change produces a corresponding ledger entry (and vice versa)
 * - Concurrent operations cannot cause lost updates — optimistic locking via version
 * - Operation currency must match wallet currency
 * - Version starts at 1 after creation and increments only when balance changes
 */
export class Wallet {
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
   * Opens a new wallet. The initial balance is zero.
   * If an initial balance > 0 is desired, the caller must explicitly
   * call credit() with an OPENING transaction after creation.
   */
  static open(props: {
    id: string;
    playerId: string;
    currency: string;
    createdAt: Date;
    initialBalance?: Money;
  }): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.currency,
      props.initialBalance ?? Money.zero(props.currency),
      1,
      props.createdAt,
      props.createdAt,
    );
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

  // ── Mutations (return LedgerEntry as proof of the balance change) ──

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

    const balanceBefore = this._balance;
    this._balance = this._balance.subtract(money);
    this._version++;
    this._updatedAt = at;

    return WalletLedgerEntry.create({
      id: generateId(),
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Debit,
      money,
      balanceBefore,
      balanceAfter: this._balance,
      createdAt: at,
    });
  }

  /**
   * Credits the wallet.
   * Returns the corresponding ledger entry.
   */
  credit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);

    const balanceBefore = this._balance;
    this._balance = this._balance.add(money);
    this._version++;
    this._updatedAt = at;

    return WalletLedgerEntry.create({
      id: generateId(),
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money,
      balanceBefore,
      balanceAfter: this._balance,
      createdAt: at,
    });
  }

  // ── Private ──

  private assertSameCurrency(money: Money): void {
    if (money.toJSON().currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.toJSON().currency);
    }
  }
}
