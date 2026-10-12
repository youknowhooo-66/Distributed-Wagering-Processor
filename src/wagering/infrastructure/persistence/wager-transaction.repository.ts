import { Injectable } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import type { WagerTransactionRepositoryPort } from '../../domain/wager-transaction.repository.port';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.entity';
import { InboxMessage } from '../../domain/inbox-message.entity';
import { OutboxMessage } from '../../domain/outbox-message.entity';
import { WagerTransactionMikroEntity } from './wager-transaction.mikro-entity';
import { InboxMessageMikroEntity } from './inbox-message.mikro-entity';
import { OutboxMessageMikroEntity } from './outbox-message.mikro-entity';
import { FailureCode } from '../../../shared/domain/errors';

@Injectable()
export class WagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionMikroEntity, { id });
    return entity ? this.toDomain(entity) : null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionMikroEntity, { idempotencyKey: key });
    return entity ? this.toDomain(entity) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionMikroEntity, {
      providerId,
      externalTransactionId: externalId,
    });
    return entity ? this.toDomain(entity) : null;
  }

  async save(tx: WagerTransaction): Promise<void> {
    let entity = await this.em.findOne(WagerTransactionMikroEntity, { id: tx.id });
    if (!entity) {
      entity = new WagerTransactionMikroEntity();
      entity.id = tx.id;
      entity.providerId = tx.providerId;
      entity.externalTransactionId = tx.externalTransactionId;
      entity.idempotencyKey = tx.idempotencyKey;
      entity.payloadHash = tx.payloadHash;
      entity.walletId = tx.walletId;
      entity.playerId = tx.playerId;
      entity.roundId = tx.roundId;
      entity.gameId = tx.gameId;
      entity.kind = tx.kind;
      entity.amount = tx.money.amount;
      entity.currency = tx.money.currency;
      entity.referenceExternalTransactionId = tx.referenceExternalTransactionId;
      entity.referenceTransactionId = tx.referenceTransactionId;
      entity.status = tx.status;
      entity.failureCode = tx.failureCode;
      entity.createdAt = tx.createdAt;
      entity.processedAt = tx.processedAt;
      entity.retryCount = tx.retryCount;
      entity.nextRetryAt = tx.nextRetryAt;
      entity.balanceAfter = tx.balanceAfter?.amount;
      this.em.persist(entity);
    } else {
      entity.status = tx.status;
      entity.referenceTransactionId = tx.referenceTransactionId;
      entity.failureCode = tx.failureCode;
      entity.processedAt = tx.processedAt;
      entity.retryCount = tx.retryCount;
      entity.nextRetryAt = tx.nextRetryAt;
      entity.balanceAfter = tx.balanceAfter?.amount;
    }
  }

  async saveInboxMessage(inbox: InboxMessage): Promise<void> {
    let entity = await this.em.findOne(InboxMessageMikroEntity, {
      consumerName: inbox.consumerName,
      messageId: inbox.messageId,
    });
    if (!entity) {
      entity = new InboxMessageMikroEntity();
      entity.consumerName = inbox.consumerName;
      entity.messageId = inbox.messageId;
      entity.payloadHash = inbox.payloadHash;
      entity.receivedAt = inbox.receivedAt;
      entity.processedAt = inbox.processedAt;
      this.em.persist(entity);
    } else {
      entity.processedAt = inbox.processedAt;
    }
  }

  async findInboxMessage(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const entity = await this.em.findOne(InboxMessageMikroEntity, {
      consumerName,
      messageId,
    });
    if (!entity) return null;

    return InboxMessage.rehydrate({
      consumerName: entity.consumerName,
      messageId: entity.messageId,
      payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt,
      processedAt: entity.processedAt,
    });
  }

  async saveOutboxMessage(outbox: OutboxMessage): Promise<void> {
    let entity = await this.em.findOne(OutboxMessageMikroEntity, { id: outbox.id });
    if (!entity) {
      entity = new OutboxMessageMikroEntity();
      entity.id = outbox.id;
      entity.aggregateId = outbox.aggregateId;
      entity.eventType = outbox.eventType;
      entity.payload = outbox.payload as Record<string, unknown>;
      entity.occurredAt = outbox.occurredAt;
      entity.attempts = outbox.attempts;
      entity.nextAttemptAt = outbox.nextAttemptAt;
      entity.publishedAt = outbox.publishedAt;
      this.em.persist(entity);
    } else {
      entity.attempts = outbox.attempts;
      entity.nextAttemptAt = outbox.nextAttemptAt;
      entity.publishedAt = outbox.publishedAt;
    }
  }

  /**
   * Fetches pending outbox messages using FOR UPDATE SKIP LOCKED
   * so multiple background publisher workers can run concurrently without collision.
   */
  async findPendingOutboxMessages(limit: number): Promise<OutboxMessage[]> {
    const now = new Date();
    const entities = await this.em.find(
      OutboxMessageMikroEntity,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        limit,
        orderBy: { occurredAt: 'ASC' },
        lockMode: LockMode.PESSIMISTIC_WRITE_OR_FAIL, // or FOR UPDATE SKIP LOCKED via custom QB
      },
    );

    return entities.map((e) =>
      OutboxMessage.rehydrate({
        id: e.id,
        aggregateId: e.aggregateId,
        eventType: e.eventType,
        payload: e.payload,
        occurredAt: e.occurredAt,
        attempts: e.attempts,
        nextAttemptAt: e.nextAttemptAt,
        publishedAt: e.publishedAt,
      }),
    );
  }

  async findDuePendingReferences(limit: number, now: Date): Promise<WagerTransaction[]> {
    const entities = await this.em.find(
      WagerTransactionMikroEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
      },
      {
        limit,
        orderBy: { createdAt: 'ASC' },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );

    return entities.map((e) => this.toDomain(e));
  }

  async countPendingReferences(): Promise<number> {
    return this.em.count(WagerTransactionMikroEntity, { status: WagerTransactionStatus.PendingReference });
  }

  async purgePublishedOutbox(olderThan: Date, limit: number): Promise<number> {
    // SKIP LOCKED: concurrent purgers on other instances take disjoint rows
    const rows = await this.em.getConnection().execute(
      `DELETE FROM outbox_messages WHERE id IN (
         SELECT id FROM outbox_messages
          WHERE published_at IS NOT NULL AND published_at < ?
          ORDER BY published_at
          LIMIT ?
          FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [olderThan, limit],
    );
    return rows.length;
  }

  async purgeProcessedInbox(olderThan: Date, limit: number): Promise<number> {
    const rows = await this.em.getConnection().execute(
      `DELETE FROM inbox_messages WHERE (consumer_name, message_id) IN (
         SELECT consumer_name, message_id FROM inbox_messages
          WHERE processed_at IS NOT NULL AND processed_at < ?
          ORDER BY processed_at
          LIMIT ?
          FOR UPDATE SKIP LOCKED)
       RETURNING message_id`,
      [olderThan, limit],
    );
    return rows.length;
  }

  async hasReversal(referenceTransactionId: string, reversalKind?: string): Promise<boolean> {
    const where: Record<string, unknown> = {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
    };
    if (reversalKind) {
      where.kind = reversalKind;
    } else {
      where.kind = { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] };
    }
    const count = await this.em.count(WagerTransactionMikroEntity, where);
    return count > 0;
  }

  private toDomain(entity: WagerTransactionMikroEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind,
      moneyAmount: entity.amount,
      moneyCurrency: entity.currency,
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      referenceTransactionId: entity.referenceTransactionId,
      status: entity.status as WagerTransactionStatus,
      failureCode: entity.failureCode as FailureCode | undefined,
      createdAt: entity.createdAt,
      processedAt: entity.processedAt,
      retryCount: entity.retryCount,
      nextRetryAt: entity.nextRetryAt,
      balanceAfter: entity.balanceAfter,
    });
  }
}
