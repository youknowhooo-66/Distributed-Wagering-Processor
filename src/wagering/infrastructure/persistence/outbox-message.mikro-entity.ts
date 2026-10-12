import { Entity, PrimaryKey, Property, Index, Check } from '@mikro-orm/core';

@Entity({ tableName: 'outbox_messages' })
@Check({ expression: 'attempts >= 0', name: 'chk_outbox_attempts' })
@Index({ properties: ['nextAttemptAt', 'publishedAt'], name: 'idx_outbox_pending' })
export class OutboxMessageMikroEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ length: 100 })
  eventType!: string;

  @Property({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'integer', default: 0 })
  attempts: number = 0;

  @Property({ type: 'timestamptz', nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: 'timestamptz', nullable: true })
  publishedAt?: Date;
}
