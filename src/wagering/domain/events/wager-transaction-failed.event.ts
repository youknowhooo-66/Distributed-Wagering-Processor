import { IntegrationEvent } from '../../../shared/domain/events/integration-event';
import { EventContext } from '../../../shared/domain/events/event-context';
import { MoneyProps } from '../../../shared/domain/value-objects';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction.entity';
import { FailureCode } from '../../../shared/domain/errors';
import { generateId } from '../../../shared/domain/identifier';

export interface WagerTransactionFailedData {
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
  failureCode: FailureCode;
  failedAt: string;
}

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(
    tx: WagerTransaction,
    failureCode: FailureCode,
    ctx: EventContext,
  ): WagerTransactionFailed {
    return new WagerTransactionFailed({
      eventId: generateId(),
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: tx.processedAt ?? new Date(),
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
        failureCode,
        failedAt: (tx.processedAt ?? new Date()).toISOString(),
      },
    });
  }
}
