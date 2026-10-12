import { Entity, PrimaryKey, Property, Unique, Check } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'], name: 'uq_wallets_player_currency' })
@Check({ expression: 'balance_amount >= 0', name: 'chk_wallets_balance_non_negative' })
@Check({ expression: 'version >= 1', name: 'chk_wallets_version_positive' })
@Check({ expression: "currency ~ '^[A-Z]{3}$'", name: 'chk_wallets_currency_iso' })
export class WalletMikroEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  balanceAmount!: string;

  @Property({ version: true })
  version!: number;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'timestamptz', onUpdate: () => new Date() })
  updatedAt!: Date;
}
