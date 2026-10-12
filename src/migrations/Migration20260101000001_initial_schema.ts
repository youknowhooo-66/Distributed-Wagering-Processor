import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000001_initial_schema extends Migration {
  async up(): Promise<void> {
    // 1. Wallets
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_amount NUMERIC(19, 2) NOT NULL DEFAULT 0.00,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT chk_wallets_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    // 2. Wallet Ledger Entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL,
        direction VARCHAR(6) NOT NULL,
        amount NUMERIC(19, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(19, 2) NOT NULL,
        balance_after NUMERIC(19, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_ledger_balance_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT chk_ledger_arithmetic CHECK (
          (direction = 'DEBIT' AND balance_after = balance_before - amount) OR
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
        ),
        CONSTRAINT uq_ledger_transaction UNIQUE (wallet_id, transaction_id)
      );
    `);

    this.addSql(`
      CREATE INDEX idx_ledger_wallet_created ON wallet_ledger_entries (wallet_id, created_at DESC);
    `);

    // 3. Wager Transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        external_transaction_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(512) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id VARCHAR(255) NOT NULL,
        game_id VARCHAR(255) NOT NULL,
        kind VARCHAR(10) NOT NULL,
        amount NUMERIC(19, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(255),
        reference_transaction_id UUID,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        failure_code VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        CONSTRAINT uq_wager_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT chk_wager_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT chk_wager_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT chk_wager_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT chk_wager_reference_required CHECK (
          (kind NOT IN ('REFUND', 'ROLLBACK')) OR 
          (reference_external_transaction_id IS NOT NULL)
        )
      );
    `);

    this.addSql(`
      CREATE INDEX idx_wager_pending_reference 
        ON wager_transactions (status, next_retry_at) 
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE INDEX idx_wager_provider_external_lookup 
        ON wager_transactions (provider_id, external_transaction_id);
    `);

    this.addSql(`
      CREATE INDEX idx_wager_reference_reversal 
        ON wager_transactions (reference_transaction_id, kind, status) 
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);

    // 4. Inbox Messages
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        CONSTRAINT pk_inbox PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // 5. Outbox Messages
    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        CONSTRAINT chk_outbox_attempts CHECK (attempts >= 0)
      );
    `);

    this.addSql(`
      CREATE INDEX idx_outbox_pending 
        ON outbox_messages (next_attempt_at) 
        WHERE published_at IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages CASCADE;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages CASCADE;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions CASCADE;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;');
    this.addSql('DROP TABLE IF EXISTS wallets CASCADE;');
  }
}
