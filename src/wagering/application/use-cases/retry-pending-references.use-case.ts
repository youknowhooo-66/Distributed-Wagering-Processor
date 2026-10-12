import { Injectable, Logger, Optional } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';
import { FailureCode } from '../../../shared/domain/errors';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.event';
import { OutboxMessage } from '../../domain/outbox-message.entity';
import { WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction.entity';
import {
  type TransactionScope,
  UniqueViolationError,
  UnitOfWork,
} from '../../../shared/application/ports/unit-of-work.port';
import {
  NoopWageringMetrics,
  WageringMetrics,
} from '../../../shared/application/ports/wagering-metrics.port';

const BATCH_SIZE = 20;

@Injectable()
export class RetryPendingReferencesUseCase {
  private readonly logger = new Logger(RetryPendingReferencesUseCase.name);
  private readonly MAX_RETRIES = 10;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    @Optional() private readonly metrics: WageringMetrics = new NoopWageringMetrics(),
  ) {}

  /** Returns how many pending transactions reached a terminal state. */
  async execute(now: Date = new Date()): Promise<number> {
    const due = await this.uow.transactional(({ wagers }) =>
      wagers.findDuePendingReferences(BATCH_SIZE, now),
    );

    let resolvedCount = 0;
    // One transaction per item: a failure in one never rolls back the others
    for (const pending of due) {
      try {
        if (await this.resolveOne(pending, now)) {
          resolvedCount++;
          this.metrics.pendingReferenceResolved();
        }
      } catch (err: unknown) {
        if (err instanceof UniqueViolationError && err.constraint === 'uq_wager_reference_reversal') {
          // Another reversal of the same reference committed first
          await this.uow.transactional((scope) =>
            this.reject(scope, pending.id, FailureCode.REFERENCE_ALREADY_REVERSED),
          );
          resolvedCount++;
          this.metrics.pendingReferenceResolved();
        } else {
          this.logger.error(`Error resolving pending reference for tx ${pending.id}: ${err}`);
        }
      }
    }
    this.metrics.pendingReferencesCurrent(
      await this.uow.transactional(({ wagers }) => wagers.countPendingReferences()),
    );
    return resolvedCount;
  }

  private resolveOne(pending: WagerTransaction, now: Date): Promise<boolean> {
    return this.uow.transactional(async (scope) => {
      // Same lock order as the main flow (wallet first). Re-reading after the lock makes
      // concurrent workers on other instances see a pending tx already resolved by a peer.
      await scope.wallets.findByIdForUpdate(pending.walletId);
      const tx = await scope.wagers.findById(pending.id);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return false;

      if (tx.retryCount >= this.MAX_RETRIES) {
        await this.reject(scope, tx.id, FailureCode.REFERENCE_TIMEOUT);
        this.logger.warn(
          `Transaction ${tx.id} timed out waiting for reference: marked REJECTED with REFERENCE_TIMEOUT`,
        );
        return true;
      }

      const ref = tx.referenceExternalTransactionId
        ? await scope.wagers.findByProviderAndExternalId(tx.providerId, tx.referenceExternalTransactionId)
        : null;
      if (!ref) {
        // Reference still missing: schedule next backoff attempt
        tx.scheduleRetry(now);
        await scope.wagers.save(tx);
        return false;
      }

      // Replays the persisted payload, so the idempotency hash matches the stored one
      await this.processWagerUseCase.executeInScope(scope, {
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey,
        playerId: tx.playerId,
        walletId: tx.walletId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
      });
      // Flush inside the try of execute(): unique violations surface here, not at a later commit
      await scope.flush();
      this.logger.log(`Successfully resolved pending reference for tx ${tx.id}`);
      return true;
    });
  }

  private async reject(scope: TransactionScope, txId: string, failureCode: FailureCode): Promise<void> {
    const tx = await scope.wagers.findById(txId);
    if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return;
    const wallet = await scope.wallets.findById(tx.walletId);
    tx.reject(failureCode, wallet?.balance);
    await scope.wagers.save(tx);
    const rejectedEvent = WagerTransactionRejected.from(tx, failureCode, { correlationId: tx.id });
    await scope.wagers.saveOutboxMessage(OutboxMessage.enqueue(rejectedEvent));
  }
}
