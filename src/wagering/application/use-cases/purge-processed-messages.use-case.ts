import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../../shared/application/ports/unit-of-work.port';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1000;
/** Bounded work per run so one instance never holds the tables for long. */
const MAX_BATCHES_PER_RUN = 50;
/**
 * SQS keeps a message for at most 14 days. The inbox deduplicates redeliveries, so it must
 * outlive any message that could still be redelivered.
 */
export const MIN_INBOX_RETENTION_DAYS = 15;

export interface RetentionPolicy {
  outboxDays: number;
  inboxDays: number;
}

export function retentionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const outboxDays = Number(env.OUTBOX_RETENTION_DAYS ?? '7');
  const inboxDays = Number(env.INBOX_RETENTION_DAYS ?? '30');
  if (!Number.isFinite(outboxDays) || outboxDays < 1) {
    throw new Error(`OUTBOX_RETENTION_DAYS must be >= 1 (got "${env.OUTBOX_RETENTION_DAYS}")`);
  }
  if (!Number.isFinite(inboxDays) || inboxDays < MIN_INBOX_RETENTION_DAYS) {
    throw new Error(
      `INBOX_RETENTION_DAYS must be >= ${MIN_INBOX_RETENTION_DAYS} to outlive SQS redelivery (got "${env.INBOX_RETENTION_DAYS}")`,
    );
  }
  return { outboxDays, inboxDays };
}

export interface PurgeResult {
  outboxDeleted: number;
  inboxDeleted: number;
}

/** Removes published outbox messages and processed inbox records past their retention. */
@Injectable()
export class PurgeProcessedMessagesUseCase {
  private readonly logger = new Logger(PurgeProcessedMessagesUseCase.name);
  private readonly policy: RetentionPolicy = retentionPolicyFromEnv();

  constructor(private readonly uow: UnitOfWork) {}

  async execute(now: Date = new Date(), policy: RetentionPolicy = this.policy): Promise<PurgeResult> {
    const outboxCutoff = new Date(now.getTime() - policy.outboxDays * DAY_MS);
    const inboxCutoff = new Date(now.getTime() - policy.inboxDays * DAY_MS);

    const outboxDeleted = await this.purgeInBatches((limit) =>
      this.uow.transactional(({ wagers }) => wagers.purgePublishedOutbox(outboxCutoff, limit)),
    );
    const inboxDeleted = await this.purgeInBatches((limit) =>
      this.uow.transactional(({ wagers }) => wagers.purgeProcessedInbox(inboxCutoff, limit)),
    );

    if (outboxDeleted > 0 || inboxDeleted > 0) {
      this.logger.log({ msg: 'retention purge', outboxDeleted, inboxDeleted });
    }
    return { outboxDeleted, inboxDeleted };
  }

  /** Short transactions of BATCH_SIZE rows until a partial batch or the per-run cap. */
  private async purgeInBatches(purge: (limit: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const deleted = await purge(BATCH_SIZE);
      total += deleted;
      if (deleted < BATCH_SIZE) break;
    }
    return total;
  }
}
