import { WagerTransaction } from './wager-transaction.entity';
import { InboxMessage } from './inbox-message.entity';
import { OutboxMessage } from './outbox-message.entity';

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WagerTransactionRepositoryPort');

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  save(transaction: WagerTransaction): Promise<void>;
  saveInboxMessage(inbox: InboxMessage): Promise<void>;
  findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  saveOutboxMessage(outbox: OutboxMessage): Promise<void>;
  findPendingOutboxMessages(limit: number): Promise<OutboxMessage[]>;
  findDuePendingReferences(limit: number, now: Date): Promise<WagerTransaction[]>;
  countPendingReferences(): Promise<number>;
  /** Deletes up to `limit` outbox messages published before `olderThan`; returns how many. */
  purgePublishedOutbox(olderThan: Date, limit: number): Promise<number>;
  /** Deletes up to `limit` inbox records processed before `olderThan`; returns how many. */
  purgeProcessedInbox(olderThan: Date, limit: number): Promise<number>;
  hasReversal(referenceTransactionId: string, reversalKind?: string): Promise<boolean>;
}
