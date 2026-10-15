import { Money } from '../../shared/domain/value-objects';
import { InvalidLedgerEntryError } from '../../shared/domain/errors';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version after this entry (the wallet's balance version it produced). */
  walletVersion: number;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  moneyAmount: string;
  moneyCurrency: string;
  balanceBeforeAmount: string;
  balanceBeforeCurrency: string;
  balanceAfterAmount: string;
  balanceAfterCurrency: string;
  walletVersion: number;
  createdAt: Date;
}

/**
 * Immutable ledger entry — no mutable fields, no transition methods.
 * Immutability is structural: the class exposes no setters or mutation methods.
 *
 * The `create` factory validates the arithmetic invariant:
 *   - DEBIT:  balanceBefore - money === balanceAfter
 *   - CREDIT: balanceBefore + money === balanceAfter
 *
 * One transaction produces at most one ledger entry per wallet.
 * Operations without balance effect (LOSS, REJECTED) produce no entry.
 *
 * `walletVersion` is the wallet version this entry moved the balance to. Versions form a
 * gap-free sequence per wallet (one balance change = one entry = version + 1), which
 * PostgreSQL enforces (UNIQUE + deferred triggers) and the ledger cursor relies on.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt,
    );

    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(`amount must be greater than zero: ${props.money.toString()}`);
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError(`walletVersion must be a positive integer: ${props.walletVersion}`);
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `arithmetic mismatch: balanceBefore=${props.balanceBefore.toString()}, ` +
        `direction=${props.direction}, money=${props.money.toString()}, ` +
        `balanceAfter=${props.balanceAfter.toString()}`,
      );
    }

    return entry;
  }

  /**
   * Reconstructs from persistence — skips arithmetic validation
   * because persisted data was already validated at creation time.
   */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.fromInternal(state.moneyAmount, state.moneyCurrency),
      Money.fromInternal(state.balanceBeforeAmount, state.balanceBeforeCurrency),
      Money.fromInternal(state.balanceAfterAmount, state.balanceAfterCurrency),
      state.walletVersion,
      state.createdAt,
    );
  }

  /**
   * Validates: balanceBefore ± money === balanceAfter
   */
  isBalanced(): boolean {
    if (this.direction === LedgerDirection.Debit) {
      return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
    }
    return this.balanceBefore.add(this.money).equals(this.balanceAfter);
  }
}
