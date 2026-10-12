import { Injectable } from '@nestjs/common';
import { WageringMetrics } from '../../application/ports/wagering-metrics.port';
import {
  idempotentReplaysTotal,
  optimisticLockConflictsTotal,
  pendingReferencesGauge,
  pendingReferencesResolved,
  reconciliationDiscrepancies,
  retryAttemptsTotal,
  transactionDurationMs,
  wagersFailedTotal,
  wagersProcessedTotal,
  wagersRejectedTotal,
} from './metrics.controller';

@Injectable()
export class PrometheusWageringMetrics extends WageringMetrics {
  transactionCompleted(
    kind: string,
    outcome: 'processed' | 'rejected' | 'idempotent_replay' | 'pending_reference' | 'failed',
    durationMs: number,
    failureCode?: string,
  ): void {
    if (outcome === 'processed') wagersProcessedTotal.inc({ kind });
    if (outcome === 'rejected') wagersRejectedTotal.inc({ kind, failure_code: failureCode ?? 'UNKNOWN' });
    if (outcome === 'idempotent_replay') idempotentReplaysTotal.inc({ kind });
    transactionDurationMs.observe({ kind, outcome }, durationMs);
  }

  transactionFailed(kind: string): void {
    wagersFailedTotal.inc({ kind });
  }

  concurrencyConflict(reason: 'lock_timeout' | 'optimistic_lock', willRetry: boolean): void {
    optimisticLockConflictsTotal.inc();
    if (willRetry) retryAttemptsTotal.inc({ type: reason });
  }

  pendingReferenceResolved(): void {
    pendingReferencesResolved.inc();
  }

  pendingReferencesCurrent(count: number): void {
    pendingReferencesGauge.set(count);
  }

  reconciliationDiscrepancy(): void {
    reconciliationDiscrepancies.inc();
  }
}
