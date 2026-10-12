/**
 * Application port for business telemetry. Use cases report what happened; the adapter
 * (Prometheus in production) decides how it is recorded.
 */
export abstract class WageringMetrics {
  /** A wager command finished with a result (processed, rejected, pending or idempotent replay). */
  abstract transactionCompleted(
    kind: string,
    outcome: 'processed' | 'rejected' | 'idempotent_replay' | 'pending_reference' | 'failed',
    durationMs: number,
    failureCode?: string,
  ): void;
  /** A transaction reached FAILED (permanent processing error). */
  abstract transactionFailed(kind: string): void;
  /** A lock/version conflict was hit; `willRetry` is false when retries are exhausted. */
  abstract concurrencyConflict(reason: 'lock_timeout' | 'optimistic_lock', willRetry: boolean): void;
  /** A PENDING_REFERENCE transaction reached a terminal state through the retry worker. */
  pendingReferenceResolved(): void {}
  /** Current number of PENDING_REFERENCE transactions. */
  pendingReferencesCurrent(_count: number): void {}
  /** A reconciliation found the wallet inconsistent. */
  reconciliationDiscrepancy(): void {}
}

/** Default when no adapter is wired (e.g. use cases built by hand in tests). */
export class NoopWageringMetrics extends WageringMetrics {
  transactionCompleted(): void {}
  transactionFailed(): void {}
  concurrencyConflict(): void {}
}
