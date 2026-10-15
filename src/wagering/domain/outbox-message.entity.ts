import { IntegrationEvent } from '../../shared/domain/events/integration-event';
import { generateId } from '../../shared/domain/identifier';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number = 0,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      generateId(),
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (this._publishedAt !== undefined) {
      return false;
    }
    if (!this._nextAttemptAt) {
      return true;
    }
    return this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /**
   * Backoff after the n-th failed publication: min(1s * 2^attempts, 60s).
   * Single source of the rule: the publisher worker applies it in SQL with the same value.
   */
  static retryDelayMs(attempts: number): number {
    return Math.min(1000 * Math.pow(2, attempts), 60_000);
  }

  /** Increments attempts and schedules the next attempt with {@link retryDelayMs}. */
  scheduleRetry(now: Date): void {
    this._attempts++;
    this._nextAttemptAt = new Date(now.getTime() + OutboxMessage.retryDelayMs(this._attempts));
  }
}
