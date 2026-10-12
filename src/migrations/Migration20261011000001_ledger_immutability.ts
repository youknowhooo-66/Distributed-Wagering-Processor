import { Migration } from '@mikro-orm/migrations';

export class Migration20261011000001_ledger_immutability extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE OR REPLACE FUNCTION trg_prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is immutable: UPDATE and DELETE operations are prohibited';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER trg_wallet_ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION trg_prevent_ledger_mutation();
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS trg_wallet_ledger_immutable ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS trg_prevent_ledger_mutation();');
  }
}
