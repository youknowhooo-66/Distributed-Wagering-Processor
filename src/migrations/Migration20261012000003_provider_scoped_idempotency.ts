import { Migration } from '@mikro-orm/migrations';

/**
 * Idempotency keys are chosen by each provider, so uniqueness is per provider: one provider
 * can no longer occupy, replay or conflict with another provider's key.
 */
export class Migration20261012000003_provider_scoped_idempotency extends Migration {
  async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT uq_wager_idempotency_key;');
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT uq_wager_provider_idempotency_key UNIQUE (provider_id, idempotency_key);
    `);
  }

  async down(): Promise<void> {
    // Fails if two providers already share a key: the global constraint cannot hold any more
    this.addSql('ALTER TABLE wager_transactions DROP CONSTRAINT uq_wager_provider_idempotency_key;');
    this.addSql('ALTER TABLE wager_transactions ADD CONSTRAINT uq_wager_idempotency_key UNIQUE (idempotency_key);');
  }
}
