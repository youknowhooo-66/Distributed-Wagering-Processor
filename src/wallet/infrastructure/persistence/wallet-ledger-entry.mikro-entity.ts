import { Entity, PrimaryKey, Property, Unique, Check, Index } from '@mikro-orm/core';
import { ExactDecimalType } from '../../../shared/infrastructure/database/exact-decimal.type';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['walletId', 'transactionId'], name: 'uq_ledger_transaction' })
@Unique({ properties: ['walletId', 'walletVersion'], name: 'uq_ledger_wallet_version' })
@Check({ expression: 'wallet_version >= 1', name: 'chk_ledger_wallet_version_positive' })
@Check({ expression: "direction IN ('DEBIT', 'CREDIT')", name: 'chk_ledger_direction' })
@Check({ expression: 'amount > 0', name: 'chk_ledger_amount_positive' })
@Check({ expression: 'balance_before >= 0 AND balance_after >= 0', name: 'chk_ledger_balance_non_negative' })
@Check({
  expression: `(direction = 'DEBIT' AND balance_after = balance_before - amount) OR (direction = 'CREDIT' AND balance_after = balance_before + amount)`,
  name: 'chk_ledger_arithmetic',
})
@Index({ properties: ['walletId', 'createdAt'], name: 'idx_ledger_wallet_created' })
export class WalletLedgerEntryMikroEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  transactionId!: string;

  @Property({ length: 6 })
  direction!: string;

  @Property({ type: ExactDecimalType, columnType: 'numeric(19,2)', precision: 19, scale: 2 })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ type: ExactDecimalType, columnType: 'numeric(19,2)', precision: 19, scale: 2 })
  balanceBefore!: string;

  @Property({ type: ExactDecimalType, columnType: 'numeric(19,2)', precision: 19, scale: 2 })
  balanceAfter!: string;

  /** Wallet version produced by this entry: gap-free per wallet, used as the ledger cursor. */
  @Property({ type: 'integer' })
  walletVersion!: number;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;
}
