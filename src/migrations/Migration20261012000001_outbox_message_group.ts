import { Migration } from '@mikro-orm/migrations';

/**
 * Per-wallet ordering for the outbox publisher: a message may only be published when no
 * earlier unpublished message of the same group exists (see OutboxPublisherWorker).
 * Generated column, so no write path can omit or diverge from the SQS MessageGroupId rule.
 */
export class Migration20261012000001_outbox_message_group extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE outbox_messages
        ADD COLUMN message_group_id TEXT
        GENERATED ALWAYS AS (COALESCE(payload->'data'->>'walletId', aggregate_id::text)) STORED;
    `);
    this.addSql(`
      CREATE INDEX idx_outbox_group_unpublished
        ON outbox_messages (message_group_id, occurred_at, id)
        WHERE published_at IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS idx_outbox_group_unpublished;');
    this.addSql('ALTER TABLE outbox_messages DROP COLUMN IF EXISTS message_group_id;');
  }
}
