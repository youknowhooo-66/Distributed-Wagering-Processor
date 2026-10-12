import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { SQSClient, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import mikroOrmConfig from '../../shared/infrastructure/database/mikro-orm.config';
import { OutboxPublisherWorker } from '../../wagering/infrastructure/messaging/outbox-publisher.worker';
import { generateId } from '../../shared/domain/identifier';

describe('Transactional Outbox to SQS FIFO — Permanent Integration Test', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let worker1: OutboxPublisherWorker;
  let worker2: OutboxPublisherWorker;

  beforeAll(async () => {
    orm = (await CoreMikroORM.init(mikroOrmConfig)) as MikroORM;
    sqs = new SQSClient({
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    worker1 = new OutboxPublisherWorker(orm.em);
    worker2 = new OutboxPublisherWorker(orm.em);
    worker1.onModuleInit();
    worker2.onModuleInit();
  });

  afterAll(async () => {
    await worker1.onModuleDestroy();
    await worker2.onModuleDestroy();
    await orm.close(true);
  });

  it('handles concurrent publishers with FOR UPDATE SKIP LOCKED without duplicate SQS dispatch', async () => {
    const em = orm.em.fork();
    const eventIds: string[] = [];

    // Insert 10 events with unique distinct timestamp in the future or drain
    const unpubBefore = await em.getConnection().execute(
      `DELETE FROM outbox_messages WHERE published_at IS NULL`,
    );

    for (let i = 0; i < 10; i++) {
      const id = generateId();
      eventIds.push(id);
      await em.getConnection().execute(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
         VALUES (?, ?, ?, ?::jsonb, ?)`,
        [
          id,
          id,
          'WagerTransactionProcessed',
          JSON.stringify({ eventId: 'evt-' + id, walletId: id, test: true }),
          new Date(),
        ],
      );
    }

    // Run both workers simultaneously on the 10 messages
    const [pub1, pub2] = await Promise.all([
      worker1.pollAndPublish(),
      worker2.pollAndPublish(),
    ]);

    expect(pub1 + pub2).toBe(10);

    // Verify all 10 are marked published
    const unpubRows = await em.getConnection().execute(
      `SELECT COUNT(*) as count FROM outbox_messages WHERE id IN (${eventIds.map(() => '?').join(',')}) AND published_at IS NULL`,
      eventIds,
    );
    expect(Number(unpubRows[0]!.count)).toBe(0);
  });
});
