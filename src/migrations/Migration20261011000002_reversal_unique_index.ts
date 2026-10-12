import { Migration } from '@mikro-orm/migrations';

export class Migration20261011000002_reversal_unique_index extends Migration {
  async up(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS idx_wager_reference_reversal;');
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_reference_reversal 
        ON wager_transactions (reference_transaction_id, kind) 
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS uq_wager_reference_reversal;');
    this.addSql(`
      CREATE INDEX idx_wager_reference_reversal 
        ON wager_transactions (reference_transaction_id, kind, status) 
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
  }
}
