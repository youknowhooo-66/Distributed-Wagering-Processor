/**
 * Domain-level error codes for wager transaction failures.
 *
 * Each code is stable, machine-readable, and sufficient for the provider
 * to decide whether to retry, fix the payload, or give up.
 */
export enum FailureCode {
  // ── Balance ──
  /** BET larger than the available balance. */
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  /** A reversal (ROLLBACK of a WIN or REFUND) would make the balance negative. */
  REVERSAL_INSUFFICIENT_BALANCE = 'REVERSAL_INSUFFICIENT_BALANCE',
  /** A credit would take the balance above the largest storable amount (NUMERIC(19,2)). */
  BALANCE_LIMIT_EXCEEDED = 'BALANCE_LIMIT_EXCEEDED',

  // ── Reference resolution ──
  REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND',
  /** The referenced transaction never arrived within the retry budget. */
  REFERENCE_TIMEOUT = 'REFERENCE_TIMEOUT',
  /** The referenced transaction exists but ended REJECTED or FAILED. */
  REFERENCE_NOT_PROCESSED = 'REFERENCE_NOT_PROCESSED',
  REFERENCE_ALREADY_REVERSED = 'REFERENCE_ALREADY_REVERSED',
  INVALID_REFERENCE_KIND = 'INVALID_REFERENCE_KIND',

  // ── Cross-entity validation ──
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  REVERSAL_AMOUNT_MISMATCH = 'REVERSAL_AMOUNT_MISMATCH',
  CROSS_PROVIDER_REFERENCE = 'CROSS_PROVIDER_REFERENCE',
  CROSS_PLAYER_REFERENCE = 'CROSS_PLAYER_REFERENCE',
  CROSS_ROUND_REFERENCE = 'CROSS_ROUND_REFERENCE',
  CROSS_WALLET_REFERENCE = 'CROSS_WALLET_REFERENCE',
  /** The wallet does not belong to the playerId sent by the provider. */
  WALLET_PLAYER_MISMATCH = 'WALLET_PLAYER_MISMATCH',

  // ── Input validation ──
  WALLET_NOT_FOUND = 'WALLET_NOT_FOUND',
  INVALID_TRANSACTION_KIND = 'INVALID_TRANSACTION_KIND',

  // ── Idempotency ──
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',

  // ── Infrastructure ──
  PERMANENT_PROCESSING_ERROR = 'PERMANENT_PROCESSING_ERROR',
}
