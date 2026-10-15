import { Migration } from '@mikro-orm/migrations';

/**
 * Balance <-> ledger pairing enforced by PostgreSQL ("toda alteração de saldo tem um lançamento
 * correspondente no ledger, e vice-versa"; version increments only when the balance changes).
 *
 * Every ledger entry records the wallet version it produced (wallet_version, unique per wallet).
 * Checked at COMMIT (deferred constraint triggers, since the wallet UPDATE and the ledger INSERT
 * happen in either order inside the transaction):
 *
 * - wallet INSERT: version = 1, and a positive opening balance has its entry (version 1, 0 -> balance);
 * - wallet UPDATE: a balance change moves version to exactly version + 1 and has the entry
 *   (that version, old balance -> new balance); without a balance change the version stays;
 * - ledger INSERT: the entry is the wallet's current state at commit (same version, same
 *   balance_after), so an entry can only be written together with the movement it describes.
 *
 * Consequence: the ledger is a gap-free chain whose last balance_after is the stored balance,
 * i.e. wallet.balance == balance rebuilt from the ledger, guaranteed by the database. It also gives
 * the ledger a total order per wallet used by the pagination cursor.
 */
export class Migration20261015000002_ledger_wallet_version_chain extends Migration {
  async up(): Promise<void> {
    this.addSql('ALTER TABLE wallet_ledger_entries ADD COLUMN wallet_version INTEGER;');

    // Backfill: the newest entry of each wallet produced the current version, the previous one
    // version - 1, and so on. The immutability trigger is suspended only for this statement.
    this.addSql('ALTER TABLE wallet_ledger_entries DISABLE TRIGGER trg_wallet_ledger_immutable;');
    this.addSql(`
      UPDATE wallet_ledger_entries l
         SET wallet_version = r.v
        FROM (
          SELECT e.id,
                 w.version - (COUNT(*) OVER (PARTITION BY e.wallet_id)
                              - ROW_NUMBER() OVER (PARTITION BY e.wallet_id ORDER BY e.created_at, e.id)) AS v
            FROM wallet_ledger_entries e
            JOIN wallets w ON w.id = e.wallet_id
        ) r
       WHERE r.id = l.id;
    `);
    this.addSql('ALTER TABLE wallet_ledger_entries ENABLE TRIGGER trg_wallet_ledger_immutable;');
    this.addSql(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_version IS NULL OR wallet_version < 1) THEN
          RAISE EXCEPTION 'existing ledger has more entries than wallet versions: data predates the version '
                          'rules and cannot be migrated (recreate the local database: docker compose down -v)';
        END IF;
      END $$;
    `);

    this.addSql('ALTER TABLE wallet_ledger_entries ALTER COLUMN wallet_version SET NOT NULL;');
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        ADD CONSTRAINT chk_ledger_wallet_version_positive CHECK (wallet_version >= 1),
        ADD CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version);
    `);

    this.addSql(`
      CREATE FUNCTION wallet_balance_has_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.version <> 1 THEN
            RAISE EXCEPTION 'wallet % must be created at version 1', NEW.id
              USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_balance_has_ledger';
          END IF;
          IF NEW.balance_amount <> 0 AND NOT EXISTS (
               SELECT 1 FROM wallet_ledger_entries
                WHERE wallet_id = NEW.id AND wallet_version = 1
                  AND balance_before = 0 AND balance_after = NEW.balance_amount) THEN
            RAISE EXCEPTION 'opening balance of wallet % has no ledger entry', NEW.id
              USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_balance_has_ledger';
          END IF;
        ELSIF NEW.balance_amount IS DISTINCT FROM OLD.balance_amount THEN
          IF NEW.version <> OLD.version + 1 OR NOT EXISTS (
               SELECT 1 FROM wallet_ledger_entries
                WHERE wallet_id = NEW.id AND wallet_version = NEW.version
                  AND balance_before = OLD.balance_amount AND balance_after = NEW.balance_amount) THEN
            RAISE EXCEPTION 'balance change of wallet % (version % -> %) has no matching ledger entry',
                            NEW.id, OLD.version, NEW.version
              USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_balance_has_ledger';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'version of wallet % changed without a balance change', NEW.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_wallet_balance_has_ledger';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_balance_has_ledger
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_balance_has_ledger();
    `);

    this.addSql(`
      CREATE FUNCTION ledger_entry_matches_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE w record;
      BEGIN
        SELECT version, balance_amount, currency INTO w FROM wallets WHERE id = NEW.wallet_id;
        IF NOT FOUND
           OR w.version <> NEW.wallet_version
           OR w.balance_amount <> NEW.balance_after
           OR w.currency <> NEW.currency THEN
          RAISE EXCEPTION 'ledger entry % (wallet version %) does not match the state of wallet %',
                          NEW.id, NEW.wallet_version, NEW.wallet_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'trg_ledger_wallet_version';
        END IF;
        RETURN NULL;
      END $$;
    `);
    // Name sorts after trg_ledger_matches_transaction: that check reports first when both fail
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_ledger_wallet_version
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_entry_matches_wallet();
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_wallet_version ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS ledger_entry_matches_wallet();');
    this.addSql('DROP TRIGGER IF EXISTS trg_wallet_balance_has_ledger ON wallets;');
    this.addSql('DROP FUNCTION IF EXISTS wallet_balance_has_ledger();');
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        DROP CONSTRAINT IF EXISTS uq_ledger_wallet_version,
        DROP CONSTRAINT IF EXISTS chk_ledger_wallet_version_positive;
    `);
    this.addSql('ALTER TABLE wallet_ledger_entries DROP COLUMN IF EXISTS wallet_version;');
  }
}
