import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { generateId } from '../../shared/domain/identifier';
import {
  wagersProcessedTotal,
  wagersRejectedTotal,
  wagersFailedTotal,
  idempotentReplaysTotal,
  pendingReferencesGauge,
  outboxPendingGauge,
  outboxLagSecondsGauge,
  optimisticLockConflictsTotal,
  retryAttemptsTotal,
  dlqMessagesTotal,
} from '../../shared/infrastructure/metrics/metrics.controller';

describe('Metrics Verification Suite — Live Traffic & Prometheus Output', () => {
  let app: INestApplication;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    port = (app.getHttpServer().address() as any).port;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('generates diverse traffic, records all metric series and exposes them on GET /metrics in the same process', async () => {
    // 1. Create wallet
    const playerId = generateId();
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    const wallet = await createRes.json();

    // 2. Successful Bet -> increments processed counter
    const betExtId = 'metric-bet-' + generateId();
    const idemKey = 'key-' + betExtId;
    const betRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify({
        providerId: 'prov-metrics',
        externalTransactionId: betExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'r-met-1',
        gameId: 'g-met-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(betRes.status).toBe(200);

    // 3. Idempotent replay -> increments idempotentReplaysTotal
    const replayRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify({
        providerId: 'prov-metrics',
        externalTransactionId: betExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'r-met-1',
        gameId: 'g-met-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(replayRes.status).toBe(200);

    // 4. Domain rejection (insufficient balance) -> increments rejected counter
    const rejectExtId = 'metric-rej-' + generateId();
    const rejRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-' + rejectExtId,
      },
      body: JSON.stringify({
        providerId: 'prov-metrics',
        externalTransactionId: rejectExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'r-met-2',
        gameId: 'g-met-1',
        kind: 'BET',
        money: { amount: '9999.00', currency: 'BRL' },
      }),
    });
    expect(rejRes.status).toBe(422);

    // 5. Out of order (pending reference) -> increments pending references
    const oooExtId = 'metric-ooo-' + generateId();
    const oooRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-' + oooExtId,
      },
      body: JSON.stringify({
        providerId: 'prov-metrics',
        externalTransactionId: oooExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'r-met-3',
        gameId: 'g-met-1',
        kind: 'REFUND',
        money: { amount: '5.00', currency: 'BRL' },
        referenceExternalTransactionId: 'missing-ref-' + generateId(),
      }),
    });
    expect(oooRes.status).toBe(202);

    // 6. Stimulate outbox lag, DLQ, retry attempts, lock conflicts, failed counters
    optimisticLockConflictsTotal.inc();
    retryAttemptsTotal.inc({ type: 'optimistic_lock' });
    dlqMessagesTotal.inc();
    wagersFailedTotal.inc({ kind: 'BET' });
    pendingReferencesGauge.set(3);
    outboxPendingGauge.set(5);
    outboxLagSecondsGauge.set(12.5);

    // 7. Request GET /metrics on same process and verify all expected series exist with positive values
    const metricsRes = await fetch(`${baseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);
    const body = await metricsRes.text();

    expect(body).toContain('wagering_transactions_processed_total');
    expect(body).toContain('wagering_transactions_rejected_total');
    expect(body).toContain('wagering_transactions_failed_total');
    expect(body).toContain('wagering_idempotent_replays_total');
    expect(body).toContain('wagering_optimistic_lock_conflicts_total');
    expect(body).toContain('wagering_retry_attempts_total');
    expect(body).toContain('wagering_dlq_messages_total');
    expect(body).toContain('wagering_pending_references_current');
    expect(body).toContain('wagering_outbox_pending_messages');
    expect(body).toContain('wagering_outbox_lag_seconds 12.5');

    // Parse Prometheus text to assert specific numerical series > 0
    const parseMetricValue = (metricName: string): number => {
      const match = body.match(new RegExp(`^${metricName}(?:\\{[^}]*\\})?\\s+([0-9.]+)`, 'm'));
      return match?.[1] ? parseFloat(match[1]) : 0;
    };

    expect(parseMetricValue('wagering_transactions_processed_total')).toBeGreaterThan(0);
    expect(parseMetricValue('wagering_transactions_rejected_total')).toBeGreaterThan(0);
    expect(parseMetricValue('wagering_transactions_failed_total')).toBeGreaterThan(0);
    expect(parseMetricValue('wagering_idempotent_replays_total')).toBeGreaterThan(0);
    expect(parseMetricValue('wagering_optimistic_lock_conflicts_total')).toBeGreaterThan(0);
    expect(parseMetricValue('wagering_retry_attempts_total')).toBeGreaterThan(0);
    expect(parseMetricValue('wagering_dlq_messages_total')).toBeGreaterThan(0);
    expect(parseMetricValue('wagering_outbox_lag_seconds')).toBeGreaterThan(0);
  });
});
