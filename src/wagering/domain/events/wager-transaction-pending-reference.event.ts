import { IntegrationEvent } from '../../../shared/domain/events/integration-event';
import { EventContext } from '../../../shared/domain/events/event-context';
import { MoneyProps } from '../../../shared/domain/value-objects';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction.entity';
import { generateId } from '../../../shared/domain/identifier';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId: string;
  createdAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: generateId(),
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: tx.createdAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey,
        playerId: tx.playerId,
        walletId: tx.walletId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        status: tx.status,
        referenceExternalTransactionId: tx.referenceExternalTransactionId!,
        createdAt: tx.createdAt.toISOString(),
      },
    });
  }
}
