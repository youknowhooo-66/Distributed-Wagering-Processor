import {
  Injectable,
  Optional,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { Money, MoneyProps } from '../../../shared/domain/value-objects';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.entity';
import { InboxMessage } from '../../domain/inbox-message.entity';
import { OutboxMessage } from '../../domain/outbox-message.entity';
import { checkReference, checkWalletOwnership, checkWinReference, settle } from '../../domain/wager-rules';
import {
  FailureCode,
  IdempotencyConflictError,
} from '../../../shared/domain/errors';
import type { EventContext } from '../../../shared/domain/events/event-context';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.event';
import { WagerTransactionFailed } from '../../domain/events/wager-transaction-failed.event';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference.event';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';
import { computePayloadHash } from '../../../shared/domain/canonical-hash';
import { generateId } from '../../../shared/domain/identifier';
import type { Wallet } from '../../../wallet/domain/wallet.entity';
import type { WagerTransactionRepositoryPort } from '../../domain/wager-transaction.repository.port';
import {
  ConcurrencyConflictError,
  type TransactionScope,
  UniqueViolationError,
  UnitOfWork,
} from '../../../shared/application/ports/unit-of-work.port';
import {
  NoopWageringMetrics,
  WageringMetrics,
} from '../../../shared/application/ports/wagering-metrics.port';
import { notFound } from '../../../shared/application/request-validation';

export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  /** Propagated to logs and to the integration events (HTTP: X-Correlation-Id; SQS: envelope). */
  correlationId?: string;
  // SQS metadata (optional)
  sqsMessageId?: string;
  consumerName?: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

/**
 * PostgreSQL returns UUIDs lowercase; providers may send any case. Normalizing at the single
 * entry point keeps reference checks (string comparison with persisted ids) and the payload
 * hash independent of the case the provider used.
 */
function normalizeIds(cmd: ProcessWagerCommand): ProcessWagerCommand {
  return { ...cmd, playerId: cmd.playerId.toLowerCase(), walletId: cmd.walletId.toLowerCase() };
}

/** Unique constraints whose violation has a defined business meaning. */
const UQ_REFERENCE_REVERSAL = 'uq_wager_reference_reversal';
const UQ_PROVIDER_EXTERNAL = 'uq_wager_provider_external';
const UQ_IDEMPOTENCY_KEY = 'uq_wager_provider_idempotency_key';

@Injectable()
export class ProcessWagerTransactionUseCase {
  private readonly logger = new Logger(ProcessWagerTransactionUseCase.name);
  private readonly MAX_RETRIES = 6;

  constructor(
    private readonly uow: UnitOfWork,
    @Optional() private readonly metrics: WageringMetrics = new NoopWageringMetrics(),
  ) {}

  async execute(input: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const cmd = normalizeIds(input);
    this.assertExternalKind(cmd);
    const payloadHash = this.payloadHashOf(cmd);
    const t0 = Date.now();

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const result = await this.uow.transactional((scope) => this.process(scope, cmd, payloadHash));
        this.recordOutcome(cmd, result, Date.now() - t0);
        return result;
      } catch (err: unknown) {
        if (err instanceof UniqueViolationError && err.constraint === UQ_REFERENCE_REVERSAL) {
          // A concurrent reversal of the same reference won the race
          const result = await this.recordStandaloneRejection(
            cmd,
            payloadHash,
            FailureCode.REFERENCE_ALREADY_REVERSED,
          );
          this.recordOutcome(cmd, result, Date.now() - t0);
          return result;
        }

        if (err instanceof UniqueViolationError && err.constraint === UQ_PROVIDER_EXTERNAL) {
          this.logger.warn({ msg: 'external id reused under a different Idempotency-Key', ...this.logFields(cmd) });
          throw new ConflictException({
            statusCode: 409,
            error: 'EXTERNAL_TRANSACTION_CONFLICT',
            message:
              'Transaction with this providerId and externalTransactionId already exists under a different Idempotency-Key',
          });
        }

        if (err instanceof IdempotencyConflictError) {
          this.logger.warn({ msg: 'idempotency conflict: same key, different payload', ...this.logFields(cmd) });
          throw err;
        }

        // Lock/version conflicts, or a concurrent insert of the same idempotency key
        // (the next attempt sees the committed row and answers as a replay or 409).
        const retryable =
          err instanceof ConcurrencyConflictError ||
          (err instanceof UniqueViolationError && err.constraint === UQ_IDEMPOTENCY_KEY);
        if (!retryable) throw err;

        const isLockTimeout = err instanceof ConcurrencyConflictError && err.reason === 'LOCK_TIMEOUT';
        this.metrics.concurrencyConflict(isLockTimeout ? 'lock_timeout' : 'optimistic_lock', attempt < this.MAX_RETRIES);
        if (attempt < this.MAX_RETRIES) {
          // Jitter backoff between 20ms and 60ms * attempt
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 40) + 20 * attempt));
        }
      }
    }

    this.logger.warn({ msg: 'concurrency retries exhausted', attempts: this.MAX_RETRIES, ...this.logFields(cmd) });
    throw new ServiceUnavailableException('Concurrency limit exceeded on wallet modification');
  }

  /**
   * Processes the command inside a transaction owned by the caller
   * (used by the pending-reference worker to resolve within its own unit of work).
   */
  async executeInScope(scope: TransactionScope, input: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const cmd = normalizeIds(input);
    this.assertExternalKind(cmd);
    return this.process(scope, cmd, this.payloadHashOf(cmd));
  }

  async recordFailure(
    input: ProcessWagerCommand,
    failureCode: FailureCode = FailureCode.PERMANENT_PROCESSING_ERROR,
  ): Promise<ProcessWagerResult> {
    const cmd = normalizeIds(input);
    const payloadHash = this.payloadHashOf(cmd);

    const result = await this.uow.transactional(async ({ wallets, wagers }) => {
      const wallet = await wallets.findById(cmd.walletId);
      const balance = wallet ? wallet.balance : Money.zero(cmd.money.currency);
      const now = new Date();

      const tx = this.newTransaction(cmd, payloadHash, Money.from(cmd.money), now);
      tx.fail(failureCode, now, balance);
      await wagers.save(tx);
      await this.saveInbox(wagers, cmd, payloadHash, now);

      const failedEvent = WagerTransactionFailed.from(tx, failureCode, this.eventContext(cmd, tx));
      await wagers.saveOutboxMessage(OutboxMessage.enqueue(failedEvent));

      return {
        transactionId: tx.id,
        status: WagerTransactionStatus.Failed,
        balance: balance.toJSON(),
        idempotentReplay: false,
        failureCode,
      };
    });
    this.metrics.transactionFailed(cmd.kind);
    this.logger.error({ msg: 'transaction recorded as FAILED', ...this.logFields(cmd, result) });
    return result;
  }

  /** Single processing flow: wallet lock -> idempotency -> reference -> money movement -> outbox. */
  private async process(
    scope: TransactionScope,
    cmd: ProcessWagerCommand,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const { wallets, wagers } = scope;

    // 1. Serialize per wallet: row lock held until commit
    const wallet = await wallets.findByIdForUpdate(cmd.walletId);
    if (!wallet) {
      throw notFound('WALLET_NOT_FOUND', `Wallet not found: ${cmd.walletId}`);
    }

    // 2. Idempotency — payload must match for every existing state,
    // including PENDING_REFERENCE (otherwise a resend could alter amount/reference).
    const existingTx = await wagers.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey);
    if (existingTx && !existingTx.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(cmd.idempotencyKey);
    }
    if (existingTx && existingTx.status !== WagerTransactionStatus.PendingReference) {
      await this.saveInbox(wagers, cmd, payloadHash, new Date());
      // Idempotent replay: previous result with the balance recorded at the time
      return {
        transactionId: existingTx.id,
        status: existingTx.status,
        balance: existingTx.balanceAfter?.toJSON(),
        idempotentReplay: true,
        failureCode: existingTx.failureCode,
      };
    }

    // 3. Inbox deduplication for SQS (if applicable)
    if (cmd.sqsMessageId && cmd.consumerName) {
      const existingInbox = await wagers.findInboxMessage(cmd.consumerName, cmd.sqsMessageId);
      if (existingInbox?.isProcessed()) {
        const existingByExt = await wagers.findByProviderAndExternalId(
          cmd.providerId,
          cmd.externalTransactionId,
        );
        if (existingByExt) {
          this.logger.log({ msg: 'inbox dedup: message already processed', ...this.logFields(cmd) });
          return {
            transactionId: existingByExt.id,
            status: existingByExt.status,
            balance: existingByExt.balanceAfter?.toJSON(),
            idempotentReplay: true,
            failureCode: existingByExt.failureCode,
          };
        }
      }
    }

    // 4. The wallet must belong to the player and currency of the operation
    const ownershipError = checkWalletOwnership(
      { playerId: cmd.playerId, currency: cmd.money.currency },
      wallet,
    );
    if (ownershipError) {
      return this.recordRejection(scope, cmd, payloadHash, wallet, ownershipError, existingTx ?? undefined);
    }

    const now = new Date();
    // Resume an existing PENDING_REFERENCE transaction or create a new one in PENDING
    const wagerTx = existingTx ?? this.newTransaction(cmd, payloadHash, Money.from(cmd.money), now);

    // 5. Reference resolution
    let referenceTx: WagerTransaction | null = null;
    if (wagerTx.requiresReference()) {
      referenceTx = await wagers.findByProviderAndExternalId(
        cmd.providerId,
        wagerTx.referenceExternalTransactionId!,
      );
      const check = referenceTx
        ? checkReference(
            wagerTx,
            referenceTx,
            referenceTx.status === WagerTransactionStatus.Processed && (await wagers.hasReversal(referenceTx.id)),
          )
        : ({ outcome: 'WAIT' } as const);

      if (check.outcome === 'WAIT') {
        return this.awaitReference(scope, cmd, payloadHash, wallet, wagerTx, existingTx !== null, now);
      }
      if (check.outcome === 'REJECT') {
        return this.recordRejection(scope, cmd, payloadHash, wallet, check.failureCode, wagerTx);
      }
    } else if (wagerTx.kind === WagerTransactionKind.Win && wagerTx.referenceExternalTransactionId) {
      // Optional BET link: validated and recorded when the BET is known; a WIN never waits for it
      referenceTx = await wagers.findByProviderAndExternalId(cmd.providerId, wagerTx.referenceExternalTransactionId);
      const winReferenceError = referenceTx ? checkWinReference(wagerTx, referenceTx) : null;
      if (winReferenceError) {
        return this.recordRejection(scope, cmd, payloadHash, wallet, winReferenceError, wagerTx);
      }
    }

    // 6. Money movement (pure domain rules)
    const settlement = settle(wagerTx, wallet, referenceTx, now);
    if (!settlement.applied) {
      return this.recordRejection(scope, cmd, payloadHash, wallet, settlement.failureCode, wagerTx);
    }
    const ledgerEntry = settlement.entry;

    // 7. Persist atomically: wallet (version-checked), ledger, transaction, inbox, outbox
    wagerTx.markProcessed(referenceTx?.id, now, wallet.balance);
    await wallets.save(wallet);
    if (ledgerEntry) {
      await wallets.saveLedgerEntry(ledgerEntry);
    }
    await wagers.save(wagerTx);
    await this.saveInbox(wagers, cmd, payloadHash, now);

    const ctx = this.eventContext(cmd, wagerTx);
    await wagers.saveOutboxMessage(OutboxMessage.enqueue(WagerTransactionProcessed.from(wagerTx, ctx)));
    if (ledgerEntry) {
      await wagers.saveOutboxMessage(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, ctx)));
    }

    return {
      transactionId: wagerTx.id,
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  /**
   * The reference is missing or still waiting itself. A new transaction is persisted as
   * PENDING_REFERENCE (event + backoff for the worker); an identical resend of a transaction
   * that is already waiting is answered as a replay and changes nothing — the worker owns the
   * retry schedule.
   */
  private async awaitReference(
    scope: TransactionScope,
    cmd: ProcessWagerCommand,
    payloadHash: string,
    wallet: Wallet,
    wagerTx: WagerTransaction,
    alreadyWaiting: boolean,
    now: Date,
  ): Promise<ProcessWagerResult> {
    const { wagers } = scope;
    if (!alreadyWaiting) {
      wagerTx.markPendingReference();
      wagerTx.scheduleRetry(now);
      await wagers.save(wagerTx);
      const pendingEvent = WagerTransactionPendingReference.from(wagerTx, this.eventContext(cmd, wagerTx));
      await wagers.saveOutboxMessage(OutboxMessage.enqueue(pendingEvent));
    }
    await this.saveInbox(wagers, cmd, payloadHash, now);

    return {
      transactionId: wagerTx.id,
      status: WagerTransactionStatus.PendingReference,
      balance: wallet.balance.toJSON(),
      idempotentReplay: alreadyWaiting,
    };
  }

  private recordStandaloneRejection(
    cmd: ProcessWagerCommand,
    payloadHash: string,
    failureCode: FailureCode,
  ): Promise<ProcessWagerResult> {
    return this.uow.transactional(async (scope) => {
      const wallet = await scope.wallets.findById(cmd.walletId);
      const balance = wallet ? wallet.balance : Money.zero(cmd.money.currency);
      return this.recordRejection(scope, cmd, payloadHash, { balance }, failureCode);
    });
  }

  private async recordRejection(
    { wagers }: TransactionScope,
    cmd: ProcessWagerCommand,
    payloadHash: string,
    wallet: { balance: Money },
    failureCode: FailureCode,
    existingTx?: WagerTransaction,
  ): Promise<ProcessWagerResult> {
    const now = new Date();
    const tx = existingTx ?? this.newTransaction(cmd, payloadHash, Money.from(cmd.money), now);

    tx.reject(failureCode, now, wallet.balance);
    await wagers.save(tx);
    await this.saveInbox(wagers, cmd, payloadHash, now);

    const rejectedEvent = WagerTransactionRejected.from(tx, failureCode, this.eventContext(cmd, tx));
    await wagers.saveOutboxMessage(OutboxMessage.enqueue(rejectedEvent));

    return {
      transactionId: tx.id,
      status: WagerTransactionStatus.Rejected,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
      failureCode,
    };
  }

  /** Records the SQS message as processed in the inbox (no-op for HTTP commands). */
  private async saveInbox(
    wagers: WagerTransactionRepositoryPort,
    cmd: ProcessWagerCommand,
    payloadHash: string,
    now: Date,
  ): Promise<void> {
    if (!cmd.sqsMessageId || !cmd.consumerName) return;
    const inbox = InboxMessage.receive({
      consumerName: cmd.consumerName,
      messageId: cmd.sqsMessageId,
      payloadHash,
      receivedAt: now,
    });
    inbox.markProcessed(now);
    await wagers.saveInboxMessage(inbox);
  }

  private newTransaction(
    cmd: ProcessWagerCommand,
    payloadHash: string,
    money: Money,
    now: Date,
  ): WagerTransaction {
    return WagerTransaction.create({
      id: generateId(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });
  }

  /** correlationId: the caller's, else the transaction id; causationId: the SQS message, if any. */
  private eventContext(cmd: ProcessWagerCommand, tx: WagerTransaction): EventContext {
    return { correlationId: cmd.correlationId ?? tx.id, causationId: cmd.sqsMessageId };
  }

  /** SHA-256 of the canonical business payload (transport metadata excluded). */
  private payloadHashOf(cmd: ProcessWagerCommand): string {
    return computePayloadHash({
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      playerId: cmd.playerId,
      walletId: cmd.walletId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: { amount: cmd.money.amount, currency: cmd.money.currency },
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
    });
  }

  private assertExternalKind(cmd: ProcessWagerCommand): void {
    if (cmd.kind === WagerTransactionKind.Opening) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'INVALID_PAYLOAD',
        message: ['OPENING transactions are internal only'],
      });
    }
  }

  /** Identifiers only: amounts, balances and payloads never go to the logs. */
  private logFields(cmd: ProcessWagerCommand, result?: ProcessWagerResult): Record<string, unknown> {
    return {
      correlationId: cmd.correlationId,
      messageId: cmd.sqsMessageId,
      transactionId: result?.transactionId,
      walletId: cmd.walletId,
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      kind: cmd.kind,
      status: result?.status,
      failureCode: result?.failureCode,
      idempotentReplay: result?.idempotentReplay,
    };
  }

  private recordOutcome(cmd: ProcessWagerCommand, result: ProcessWagerResult, durationMs: number): void {
    const outcome = result.idempotentReplay
      ? 'idempotent_replay'
      : result.status === WagerTransactionStatus.Processed
        ? 'processed'
        : result.status === WagerTransactionStatus.Rejected
          ? 'rejected'
          : result.status === WagerTransactionStatus.PendingReference
            ? 'pending_reference'
            : 'failed';
    this.metrics.transactionCompleted(cmd.kind, outcome, durationMs, result.failureCode);
    const entry = { msg: `wager transaction ${outcome}`, durationMs, ...this.logFields(cmd, result) };
    if (outcome === 'rejected') this.logger.warn(entry);
    else this.logger.log(entry);
  }
}
