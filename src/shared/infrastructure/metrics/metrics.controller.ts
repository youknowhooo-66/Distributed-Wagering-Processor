import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { register, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

// Register default Node.js process metrics (memory, GC, event loop, etc.)
collectDefaultMetrics({ prefix: 'wagering_' });

// ── Business counters ───────────────────────────────────────────────────────

export const wagersProcessedTotal = new Counter({
  name: 'wagering_transactions_processed_total',
  help: 'Total wager transactions successfully processed',
  labelNames: ['kind'],
});

export const wagersRejectedTotal = new Counter({
  name: 'wagering_transactions_rejected_total',
  help: 'Total wager transactions rejected',
  labelNames: ['kind', 'failure_code'],
});

export const wagersFailedTotal = new Counter({
  name: 'wagering_transactions_failed_total',
  help: 'Total wager transactions that reached FAILED (permanent error)',
  labelNames: ['kind'],
});

export const idempotentReplaysTotal = new Counter({
  name: 'wagering_idempotent_replays_total',
  help: 'Total idempotent replay responses returned',
  labelNames: ['kind'],
});

export const pendingReferencesResolved = new Counter({
  name: 'wagering_pending_references_resolved_total',
  help: 'Total PENDING_REFERENCE transactions successfully resolved by the retry worker',
});

export const reconciliationDiscrepancies = new Counter({
  name: 'wagering_reconciliation_discrepancies_total',
  help: 'Total wallet reconciliation discrepancies detected',
});

export const optimisticLockConflictsTotal = new Counter({
  name: 'wagering_optimistic_lock_conflicts_total',
  help: 'Total optimistic lock conflicts encountered on wallet modification',
});

export const retryAttemptsTotal = new Counter({
  name: 'wagering_retry_attempts_total',
  help: 'Total retry attempts performed (optimistic lock or SQS consumers)',
  labelNames: ['type'],
});

export const dlqMessagesTotal = new Counter({
  name: 'wagering_dlq_messages_total',
  help: 'Total poisoned or unprocessable messages forwarded to Dead Letter Queue',
});

// ── Latency histograms ──────────────────────────────────────────────────────

export const transactionDurationMs = new Histogram({
  name: 'wagering_transaction_processing_duration_ms',
  help: 'End-to-end latency of wager transaction processing in milliseconds',
  labelNames: ['kind', 'outcome'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

// ── Gauges ──────────────────────────────────────────────────────────────────

export const pendingReferencesGauge = new Gauge({
  name: 'wagering_pending_references_current',
  help: 'Current number of PENDING_REFERENCE transactions in the system',
});

export const outboxPendingGauge = new Gauge({
  name: 'wagering_outbox_pending_messages',
  help: 'Current number of unpublished outbox messages',
});

export const outboxLagSecondsGauge = new Gauge({
  name: 'wagering_outbox_lag_seconds',
  help: 'Age in seconds of the oldest unpublished message in outbox table',
});

// ── Controller ──────────────────────────────────────────────────────────────

@Controller()
export class MetricsController {
  @Get('metrics')
  async metrics(@Res() res: Response) {
    try {
      const metrics = await register.metrics();
      res.setHeader('Content-Type', register.contentType);
      return res.status(200).send(metrics);
    } catch (err) {
      return res.status(500).send(`Metrics collection failed: ${err}`);
    }
  }
}
