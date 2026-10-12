import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../../shared/infrastructure/messaging/sqs.client';
import { OutboxMessageMikroEntity } from '../persistence/outbox-message.mikro-entity';
import { outboxLagSecondsGauge, outboxPendingGauge } from '../../../shared/infrastructure/metrics/metrics.controller';

const MAX_GROUPS_PER_POLL = 50;
const MAX_MESSAGES_PER_GROUP = 50;
/** Groups published concurrently; order only matters within a group. */
const GROUP_CONCURRENCY = 8;
const IDLE_POLL_MS = 1000;

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private sqsClient!: SQSClient;
  private isRunning = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly queueUrl =
    process.env.SQS_EVENTS_QUEUE_URL ||
    'http://localhost:4566/000000000000/wagering-events.fifo';

  constructor(private readonly em: EntityManager) {}

  onModuleInit() {
    this.sqsClient = createSqsClient();
    this.isRunning = true;
    if (process.env.ENABLE_BACKGROUND_POLL !== 'false') {
      this.scheduleNextPoll(100);
    }
  }

  onModuleDestroy() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  private scheduleNextPoll(delayMs: number) {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      let published = 0;
      try {
        published = await this.pollAndPublish();
      } catch (err) {
        this.logger.error(`Outbox publisher loop error: ${err}`);
      } finally {
        // Keep draining while there is work; wait only when the outbox is idle
        this.scheduleNextPoll(published > 0 ? 0 : IDLE_POLL_MS);
      }
    }, delayMs);
  }

  async pollAndPublish(): Promise<number> {
    const forkEm = this.em.fork();

    return forkEm.transactional(async (em) => {
      const now = new Date();
      const knex = (em as any).getKnex();
      const knexTx = (em as any).getTransactionContext();

      // Measure outbox lag in seconds (oldest unpublished message) and pending count
      const lagResult = await knex('outbox_messages')
        .transacting(knexTx)
        .whereNull('published_at')
        .select(
          knex.raw('COUNT(*) as count'),
          knex.raw('EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))) as oldest_lag_seconds'),
        );

      const pendingCount = Number(lagResult[0]?.count || '0');
      const lagSeconds = Number(lagResult[0]?.oldest_lag_seconds || '0');
      outboxPendingGauge.set(pendingCount);
      outboxLagSecondsGauge.set(lagSeconds);

      // Per-group (wallet) ordering: only groups whose oldest unpublished message is due are
      // candidates; a group is published by one publisher at a time (transaction-scoped
      // advisory lock) and strictly in (occurred_at, id) order, stopping at the first message
      // that is in backoff or fails. Later messages never overtake an earlier one.
      const dueGroups = await knexTx.raw(
        `SELECT message_group_id FROM (
           SELECT DISTINCT ON (message_group_id) message_group_id, occurred_at, next_attempt_at
             FROM outbox_messages
            WHERE published_at IS NULL
            ORDER BY message_group_id, occurred_at, id
         ) heads
         WHERE next_attempt_at IS NULL OR next_attempt_at <= ?
         ORDER BY occurred_at
         LIMIT ?`,
        [now, MAX_GROUPS_PER_POLL],
      );

      const groups = (dueGroups.rows as { message_group_id: string }[]).map((r) => r.message_group_id);
      let publishedCount = 0;
      for (let i = 0; i < groups.length; i += GROUP_CONCURRENCY) {
        const counts = await Promise.all(
          groups.slice(i, i + GROUP_CONCURRENCY).map((groupId) => this.publishGroup(knex, knexTx, groupId, now)),
        );
        publishedCount += counts.reduce((sum, n) => sum + n, 0);
      }

      return publishedCount;
    });
  }

  /**
   * Publishes one group strictly in order, stopping at the first message in backoff or failing.
   * Returns how many were published (0 when another publisher holds the group).
   */
  private async publishGroup(knex: any, knexTx: any, groupId: string, now: Date): Promise<number> {
    const lock = await knexTx.raw('SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS locked', [
      `outbox:${groupId}`,
    ]);
    if (!lock.rows[0]?.locked) return 0; // another publisher owns this group right now

    const rows = await knex('outbox_messages')
      .transacting(knexTx)
      .whereNull('published_at')
      .andWhere({ message_group_id: groupId })
      .orderBy([{ column: 'occurred_at' }, { column: 'id' }])
      .limit(MAX_MESSAGES_PER_GROUP)
      .forUpdate();

    let published = 0;
    for (const row of rows) {
      if (row.next_attempt_at && new Date(row.next_attempt_at) > now) break;
      if (!(await this.publishRow(knex, knexTx, row))) break;
      published++;
    }
    return published;
  }

  /** Publishes one outbox row; on failure schedules a backoff retry. Returns success. */
  private async publishRow(knex: any, knexTx: any, row: any): Promise<boolean> {
    try {
      const payloadObj = typeof row.payload === 'object' && row.payload !== null ? row.payload : {};
      const eventId = 'eventId' in payloadObj ? String(payloadObj.eventId) : row.id;
      // Same value used for ordering above (generated column: data.walletId, else aggregate_id)
      const groupId: string = row.message_group_id;

      await this.sqsClient.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(row.payload),
          MessageGroupId: groupId,
          MessageDeduplicationId: eventId,
          MessageAttributes: {
            EventType: { DataType: 'String', StringValue: row.event_type },
            AggregateId: { DataType: 'String', StringValue: row.aggregate_id },
            WalletId: { DataType: 'String', StringValue: groupId },
          },
        }),
      );

      await knex('outbox_messages')
        .transacting(knexTx)
        .where({ id: row.id })
        .update({ published_at: new Date() });
      return true;
    } catch (publishErr) {
      const nextAttempt = row.attempts + 1;
      const delaySec = Math.min(Math.pow(2, nextAttempt), 60);
      await knex('outbox_messages')
        .transacting(knexTx)
        .where({ id: row.id })
        .update({
          attempts: nextAttempt,
          next_attempt_at: knex.raw(`NOW() + (? || ' seconds')::INTERVAL`, [delaySec.toString()]),
        });
      this.logger.error(`Failed to publish outbox message ${row.id}: ${publishErr}`);
      return false;
    }
  }
}
