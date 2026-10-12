import { Migration } from '@mikro-orm/migrations';

export class Migration20261011000003_wager_balance_after extends Migration {
  async up(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions ADD COLUMN balance_after NUMERIC(19, 2);');
  }

  async down(): Promise<void> {
    this.addSql('ALTER TABLE wager_transactions DROP COLUMN IF EXISTS balance_after;');
  }
}
