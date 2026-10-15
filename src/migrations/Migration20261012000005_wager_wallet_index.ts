import { Migration } from '@mikro-orm/migrations';

/**
 * wager_transactions.wallet_id is a foreign key without an index: per-wallet queries
 * (reconciliation, ledger/transaction consistency) scanned the whole table, so their cost grew
 * with the total volume instead of the wallet's own history.
 */
export class Migration20261012000005_wager_wallet_index extends Migration {
  async up(): Promise<void> {
    this.addSql('CREATE INDEX idx_wager_transactions_wallet ON wager_transactions (wallet_id);');
  }

  async down(): Promise<void> {
    this.addSql('DROP INDEX IF EXISTS idx_wager_transactions_wallet;');
  }
}
