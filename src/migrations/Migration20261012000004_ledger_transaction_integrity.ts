import { Migration } from '@mikro-orm/migrations';

/**
 * Ledger and transactions must agree, enforced by PostgreSQL at COMMIT (deferred constraint
 * triggers: inside a transaction the insert order varies). Turns the reconciliation's
 * "ledger x transactions" check from detection into prevention: a ledger entry whose amount,
 * wallet, currency or direction differs from its transaction can no longer be committed.
 */
export class Migration20261012000004_ledger_transaction_integrity extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION ledger_entry_matches_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE tx record;
      BEGIN
        SELECT wallet_id, status, kind, amount, currency INTO tx
          FROM wager_transactions WHERE id = NEW.transaction_id;
        IF NOT FOUND
           OR tx.status <> 'PROCESSED'
           OR tx.kind = 'LOSS'
           OR tx.wallet_id <> NEW.wallet_id
           OR tx.amount <> NEW.amount
           OR tx.currency <> NEW.currency
           OR (tx.kind = 'BET' AND NEW.direction <> 'DEBIT')
           OR (tx.kind IN ('WIN', 'REFUND', 'OPENING') AND NEW.direction <> 'CREDIT') THEN
          RAISE EXCEPTION 'ledger entry % does not match transaction %', NEW.id, NEW.transaction_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_ledger_matches_transaction';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_ledger_matches_transaction
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_entry_matches_transaction();
    `);

    this.addSql(`
      CREATE FUNCTION processed_transaction_has_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'PROCESSED' AND NEW.kind <> 'LOSS' AND NOT EXISTS (
             SELECT 1 FROM wallet_ledger_entries
              WHERE wallet_id = NEW.wallet_id AND transaction_id = NEW.id) THEN
          RAISE EXCEPTION 'processed transaction % has no ledger entry', NEW.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_processed_transaction_has_ledger';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_processed_transaction_has_ledger
        AFTER INSERT OR UPDATE OF status ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION processed_transaction_has_ledger();
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS trg_processed_transaction_has_ledger ON wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS processed_transaction_has_ledger();');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_matches_transaction ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS ledger_entry_matches_transaction();');
  }
}
