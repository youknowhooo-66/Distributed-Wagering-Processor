import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageMikroEntity {
  @PrimaryKey({ length: 100 })
  consumerName!: string;

  @PrimaryKey({ length: 255 })
  messageId!: string;

  @Property({ length: 64 })
  payloadHash!: string;

  @Property({ type: 'timestamptz' })
  receivedAt!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  processedAt?: Date;
}
