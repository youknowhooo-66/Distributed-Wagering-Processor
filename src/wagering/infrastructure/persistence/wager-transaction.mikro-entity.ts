import { Entity, PrimaryKey, Property, Unique, Check, Index } from '@mikro-orm/core';

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'idempotencyKey'], name: 'uq_wager_provider_idempotency_key' })
@Unique({ properties: ['providerId', 'externalTransactionId'], name: 'uq_wager_provider_external' })
@Check({
  expression: "kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
  name: 'chk_wager_kind',
})
@Check({
  expression: "status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
  name: 'chk_wager_status',
})
@Check({ expression: 'amount >= 0', name: 'chk_wager_amount_non_negative' })
@Check({
  expression: "(kind NOT IN ('REFUND', 'ROLLBACK')) OR (reference_external_transaction_id IS NOT NULL)",
  name: 'chk_wager_reference_required',
})
@Index({ properties: ['status', 'nextRetryAt'], name: 'idx_wager_pending_reference' })
export class WagerTransactionMikroEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ length: 100 })
  providerId!: string;

  @Property({ length: 255 })
  externalTransactionId!: string;

  @Property({ length: 512 })
  idempotencyKey!: string;

  @Property({ length: 64 })
  payloadHash!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ length: 255 })
  roundId!: string;

  @Property({ length: 255 })
  gameId!: string;

  @Property({ length: 10 })
  kind!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ length: 255, nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ length: 20 })
  status!: string;

  @Property({ length: 100, nullable: true })
  failureCode?: string;

  @Property({ type: 'decimal', precision: 19, scale: 2, nullable: true })
  balanceAfter?: string;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  processedAt?: Date;

  @Property({ type: 'integer', default: 0 })
  retryCount: number = 0;

  @Property({ type: 'timestamptz', nullable: true })
  nextRetryAt?: Date;
}
