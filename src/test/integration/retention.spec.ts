import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../shared/infrastructure/database/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import {
  MIN_INBOX_RETENTION_DAYS,
  PurgeProcessedMessagesUseCase,
  retentionPolicyFromEnv,
} from '../../wagering/application/use-cases/purge-processed-messages.use-case';
import { generateId } from '../../shared/domain/identifier';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Retention — purge of published outbox and processed inbox', () => {
  let orm: MikroORM;
  let purge: PurgeProcessedMessagesUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    purge = new PurgeProcessedMessagesUseCase(new MikroOrmUnitOfWork(orm.em));
  });

  afterAll(async () => {
    await orm.close();
  });

  it('removes only rows past retention that were already published / processed', async () => {
    const conn = orm.em.fork().getConnection();
    const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS);
    const outbox = async (publishedAt: Date | null, occurredAt: Date) => {
      const id = generateId();
      await conn.execute(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, published_at)
         VALUES (?, ?, 'RetentionTest', '{}'::jsonb, ?, ?)`,
        [id, id, occurredAt, publishedAt],
      );
      return id;
    };
    const inbox = async (processedAt: Date | null) => {
      const id = 'retention-' + generateId();
      await conn.execute(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
         VALUES ('retention-test', ?, ?, ?, ?)`,
        [id, 'h'.repeat(64), daysAgo(60), processedAt],
      );
      return id;
    };

    const oldPublished = await outbox(daysAgo(10), daysAgo(10));
    const recentPublished = await outbox(daysAgo(1), daysAgo(1));
    // Never published (e.g. SQS down for weeks): must survive any retention
    const oldUnpublished = await outbox(null, daysAgo(60));
    const oldProcessed = await inbox(daysAgo(40));
    const recentProcessed = await inbox(daysAgo(5));
    const neverProcessed = await inbox(null);

    const result = await purge.execute(new Date(), { outboxDays: 7, inboxDays: 30 });
    expect(result.outboxDeleted).toBeGreaterThanOrEqual(1);
    expect(result.inboxDeleted).toBeGreaterThanOrEqual(1);

    const outboxLeft = (
      await conn.execute('SELECT id FROM outbox_messages WHERE id IN (?, ?, ?)', [
        oldPublished,
        recentPublished,
        oldUnpublished,
      ])
    ).map((r) => String(r.id));
    expect(outboxLeft.sort()).toEqual([recentPublished, oldUnpublished].sort());

    const inboxLeft = (
      await conn.execute('SELECT message_id FROM inbox_messages WHERE message_id IN (?, ?, ?)', [
        oldProcessed,
        recentProcessed,
        neverProcessed,
      ])
    ).map((r) => String(r.message_id));
    expect(inboxLeft.sort()).toEqual([recentProcessed, neverProcessed].sort());
  });

  it('refuses an inbox retention shorter than the SQS redelivery window', () => {
    expect(() => retentionPolicyFromEnv({ INBOX_RETENTION_DAYS: '7' })).toThrow(
      String(MIN_INBOX_RETENTION_DAYS),
    );
    expect(() => retentionPolicyFromEnv({ OUTBOX_RETENTION_DAYS: '0' })).toThrow('OUTBOX_RETENTION_DAYS');
    expect(retentionPolicyFromEnv({})).toEqual({ outboxDays: 7, inboxDays: 30 });
  });
});
