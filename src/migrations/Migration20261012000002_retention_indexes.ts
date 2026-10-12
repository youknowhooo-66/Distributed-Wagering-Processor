import { Migration } from '@mikro-orm/migrations';

/** Indexes for the retention worker: purge by age without scanning the whole tables. */
export class Migration20261012000002_retention_indexes extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE INDEX idx_outbox_published_at
        ON outbox_messages (published_at)
        WHERE published_at IS NOT NULL;
    `);
    this.addSql(`
      CREATE INDEX idx_inbox_processed_at
        ON inbox_messages (processed_at)
        WHERE processed_at IS NOT NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS idx_inbox_processed_at;');
    this.addSql('DROP INDEX IF EXISTS idx_outbox_published_at;');
  }
}
