import { Migration } from '@mikro-orm/migrations';

/**
 * WagerTransaction immutability in the schema (section 6.3 + restriction 9):
 * - PROCESSED, REJECTED and FAILED are terminal: such a row can no longer change at all;
 * - the business columns (who, what, how much, which reference) never change, in any state;
 * - a row never goes back to PENDING;
 * - transactions are audit records: no DELETE, and no TRUNCATE of this table or of the ledger.
 * Only PENDING / PENDING_REFERENCE rows move forward (status, retry schedule, outcome columns).
 */
export class Migration20261015000001_wager_transaction_guard extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION wager_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions is append-only: DELETE of % is prohibited', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;

        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%) and cannot change', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;

        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'business columns of wager transaction % are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;

        IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
          RAISE EXCEPTION 'wager transaction % cannot go back to PENDING', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;

        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wager_transaction_guard
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_transaction_guard();
    `);

    this.addSql(`
      CREATE FUNCTION prevent_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is an audit table: TRUNCATE is prohibited', TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation';
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wager_transactions_no_truncate
        BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate();
    `);
    this.addSql(`
      CREATE TRIGGER trg_wallet_ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate();
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS trg_wallet_ledger_no_truncate ON wallet_ledger_entries;');
    this.addSql('DROP TRIGGER IF EXISTS trg_wager_transactions_no_truncate ON wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS prevent_truncate();');
    this.addSql('DROP TRIGGER IF EXISTS trg_wager_transaction_guard ON wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS wager_transaction_guard();');
  }
}
