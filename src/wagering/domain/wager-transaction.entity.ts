import { Money } from '../../shared/domain/value-objects';
import {
  InvalidTransactionStateError,
  MissingReferenceError,
  FailureCode,
} from '../../shared/domain/errors';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry.entity';

// ── Enums ──

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

// ── Creation props ──

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

// ── Rehydration state ──

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  moneyAmount: string;
  moneyCurrency: string;
  referenceExternalTransactionId?: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  createdAt: Date;
  processedAt?: Date;
  retryCount: number;
  nextRetryAt?: Date;
  balanceAfter?: string;
}

/**
 * WagerTransaction entity.
 *
 * State machine:
 *   PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PENDING_REFERENCE (retry rescheduled) | PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED → (terminal, no further transitions)
 *
 * PostgreSQL enforces the same rules (trg_wager_transaction_guard): a terminal row and the
 * business columns of any row can no longer change, and rows are never deleted.
 *
 * OPENING is internal-only: cannot be submitted via API or queue.
 * Same idempotency key with different payload is a conflict, not a replay.
 *
 * Valid transitions:
 * ┌─────────────────────┬────────────────────────────────────────┐
 * │ From                │ To                                     │
 * ├─────────────────────┼────────────────────────────────────────┤
 * │ PENDING             │ PROCESSED, REJECTED, FAILED,           │
 * │                     │ PENDING_REFERENCE                      │
 * │ PENDING_REFERENCE   │ PENDING_REFERENCE, PROCESSED,          │
 * │                     │ REJECTED, FAILED                       │
 * │ PROCESSED           │ (none — terminal)                      │
 * │ REJECTED            │ (none — terminal)                      │
 * │ FAILED              │ (none — terminal)                      │
 * └─────────────────────┴────────────────────────────────────────┘
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _retryCount: number = 0,
    private _nextRetryAt?: Date,
    private _balanceAfter?: Money,
  ) {}

  /**
   * Creates a new WagerTransaction in PENDING status.
   * Validates that REFUND and ROLLBACK require a reference.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const tx = new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );

    // Validate reference requirement at creation
    if (tx.requiresReference() && !props.referenceExternalTransactionId) {
      throw new MissingReferenceError(props.kind);
    }

    return tx;
  }

  /**
   * Reconstructs from persistence — no re-validation.
   */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.fromInternal(state.moneyAmount, state.moneyCurrency),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.retryCount,
      state.nextRetryAt,
      state.balanceAfter
        ? Money.fromInternal(state.balanceAfter, state.moneyCurrency)
        : undefined,
    );
  }

  // ── Getters ──

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get retryCount(): number {
    return this._retryCount;
  }

  get nextRetryAt(): Date | undefined {
    return this._nextRetryAt;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  // ── State transitions ──

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    balanceAfter?: Money,
  ): void {
    this.assertNotTerminal('PROCESSED');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    if (balanceAfter) {
      this._balanceAfter = balanceAfter;
    }
  }

  markPendingReference(): void {
    this.assertNotTerminal('PENDING_REFERENCE');
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, at: Date, balanceAfter?: Money): void {
    this.assertNotTerminal('REJECTED');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    if (balanceAfter) {
      this._balanceAfter = balanceAfter;
    }
  }

  fail(code: FailureCode, at: Date, balanceAfter?: Money): void {
    this.assertNotTerminal('FAILED');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    if (balanceAfter) {
      this._balanceAfter = balanceAfter;
    }
  }

  /**
   * Increments retry count and calculates next retry with exponential backoff.
   * Base delay: 1s, max delay: 300s (5 min), formula: min(1s * 2^retryCount, 300s)
   */
  scheduleRetry(now: Date): void {
    this._retryCount++;
    const baseDelayMs = 1000;
    const maxDelayMs = 300_000;
    const delayMs = Math.min(baseDelayMs * Math.pow(2, this._retryCount), maxDelayMs);
    this._nextRetryAt = new Date(now.getTime() + delayMs);
  }

  // ── Domain queries ──

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /**
   * Returns true if this transaction kind affects the wallet balance.
   * LOSS does not affect balance.
   */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /**
   * Returns true if this kind requires a referenceExternalTransactionId.
   * REFUND and ROLLBACK require references.
   */
  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  /**
   * Checks whether the given payload hash matches this transaction's payload hash.
   */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Determines the ledger direction for this transaction kind.
   * For ROLLBACK, the direction is the inverse of the referenced transaction.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new Error('ROLLBACK requires a reference transaction to determine ledger direction');
        }
        // Inverse of the reference's direction
        const refDirection = reference.ledgerDirectionFor();
        return refDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }

      case WagerTransactionKind.Loss:
        throw new Error('LOSS does not produce a ledger entry');

      default:
        throw new Error(`Unknown transaction kind: ${this.kind}`);
    }
  }

  // ── Private ──

  private assertNotTerminal(attemptedTransition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        attemptedTransition,
      );
    }
  }
}
