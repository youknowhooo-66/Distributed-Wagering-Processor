import { FailureCode } from '../../shared/domain/errors';
import { Wallet } from '../../wallet/domain/wallet.entity';
import { LedgerDirection, WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.entity';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.entity';

/**
 * Business rules of section 7, as pure functions over the domain objects.
 * The use case only orchestrates I/O (locks, lookups, persistence, outbox) around them,
 * so every rule here is unit-tested without a database.
 */

/** Kinds each reversal may reference (rule 3). */
const REVERSIBLE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export type ReferenceCheck =
  | { outcome: 'VALID' }
  /** The reference exists but is itself waiting (PENDING / PENDING_REFERENCE): try again later. */
  | { outcome: 'WAIT' }
  | { outcome: 'REJECT'; failureCode: FailureCode };

/**
 * Validates a REFUND/ROLLBACK against the transaction it references (rules 2–5).
 *
 * Order matters: contextual mismatches are rejected immediately, even while the reference is
 * still waiting, because they can never become valid. Only a reference that matches but is
 * not terminal yet makes the reversal wait — so a chain that arrives fully out of order
 * (ROLLBACK -> REFUND -> BET) resolves instead of being rejected.
 *
 * @param alreadyReversed whether a PROCESSED REFUND/ROLLBACK of `reference` already exists
 */
export function checkReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): ReferenceCheck {
  const reject = (failureCode: FailureCode): ReferenceCheck => ({ outcome: 'REJECT', failureCode });

  if (reference.providerId !== tx.providerId) return reject(FailureCode.CROSS_PROVIDER_REFERENCE);
  if (reference.playerId !== tx.playerId) return reject(FailureCode.CROSS_PLAYER_REFERENCE);
  if (reference.walletId !== tx.walletId) return reject(FailureCode.CROSS_WALLET_REFERENCE);
  if (reference.roundId !== tx.roundId) return reject(FailureCode.CROSS_ROUND_REFERENCE);
  if (reference.money.currency !== tx.money.currency) return reject(FailureCode.CURRENCY_MISMATCH);
  if (!reference.money.equals(tx.money)) return reject(FailureCode.REVERSAL_AMOUNT_MISMATCH);

  const allowed = REVERSIBLE_KINDS[tx.kind];
  if (allowed && !allowed.includes(reference.kind)) return reject(FailureCode.INVALID_REFERENCE_KIND);

  switch (reference.status) {
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return { outcome: 'WAIT' };
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return reject(FailureCode.REFERENCE_NOT_PROCESSED);
    case WagerTransactionStatus.Processed:
      break;
  }

  if (allowed && alreadyReversed) return reject(FailureCode.REFERENCE_ALREADY_REVERSED);
  return { outcome: 'VALID' };
}

export type Settlement =
  /** Applied; `entry` is absent when the kind does not move money (LOSS). */
  | { applied: true; entry?: WalletLedgerEntry }
  | { applied: false; failureCode: FailureCode };

/**
 * Applies the transaction to the wallet (section 7 table):
 * BET debits, WIN/REFUND credit, LOSS moves nothing, ROLLBACK applies the inverse of its
 * reference. A debit that would make the balance negative is not applied; a reversal gets a
 * failure code distinct from a plain BET without funds (rule 9).
 */
export function settle(
  tx: WagerTransaction,
  wallet: Wallet,
  reference: WagerTransaction | null,
  at: Date,
): Settlement {
  if (!tx.affectsBalance()) return { applied: true };

  const direction = tx.ledgerDirectionFor(reference ?? undefined);
  if (direction === LedgerDirection.Credit) {
    return { applied: true, entry: wallet.credit(tx.id, tx.money, at) };
  }

  if (wallet.balance.isLessThan(tx.money)) {
    return {
      applied: false,
      failureCode: tx.requiresReference()
        ? FailureCode.REVERSAL_INSUFFICIENT_BALANCE
        : FailureCode.INSUFFICIENT_BALANCE,
    };
  }
  return { applied: true, entry: wallet.debit(tx.id, tx.money, at) };
}

/**
 * The wallet must belong to the player and currency the provider sent. Returns the failure
 * code, or null when the transaction may touch this wallet.
 */
export function checkWalletOwnership(tx: { playerId: string; currency: string }, wallet: Wallet): FailureCode | null {
  if (wallet.playerId !== tx.playerId) return FailureCode.WALLET_PLAYER_MISMATCH;
  if (wallet.currency !== tx.currency) return FailureCode.CURRENCY_MISMATCH;
  return null;
}
