import { Migration } from '@mikro-orm/migrations';

export class Migration20261011000004_strict_single_reversal_index extends Migration {
  async up(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS uq_wager_reference_reversal;');
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_reference_reversal 
        ON wager_transactions (reference_transaction_id) 
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS uq_wager_reference_reversal;');
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_reference_reversal 
        ON wager_transactions (reference_transaction_id, kind) 
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
  }
}
