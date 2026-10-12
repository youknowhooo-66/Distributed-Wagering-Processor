import {
  Injectable,
  Optional,
  ConflictException,
  BadRequestException,
  NotFoundException,
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
import {
  FailureCode,
  IdempotencyConflictError,
} from '../../../shared/domain/errors';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.event';
import { WagerTransactionFailed } from '../../domain/events/wager-transaction-failed.event';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference.event';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event';
import { computePayloadHash } from '../../../shared/domain/canonical-hash';
import { generateId } from '../../../shared/domain/identifier';
import { LedgerDirection, WalletLedgerEntry } from '../../../wallet/domain/wallet-ledger-entry.entity';
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
const UQ_IDEMPOTENCY_KEY = 'uq_wager_idempotency_key';

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
        this.recordOutcomeMetrics(cmd.kind, result, Date.now() - t0);
        return result;
      } catch (err: unknown) {
        if (err instanceof UniqueViolationError && err.constraint === UQ_REFERENCE_REVERSAL) {
          // A concurrent reversal of the same reference won the race
          const result = await this.recordStandaloneRejection(
            cmd,
            payloadHash,
            FailureCode.REFERENCE_ALREADY_REVERSED,
          );
          this.recordOutcomeMetrics(cmd.kind, result, Date.now() - t0);
          return result;
        }

        if (err instanceof UniqueViolationError && err.constraint === UQ_PROVIDER_EXTERNAL) {
          throw new ConflictException(
            'Transaction with this providerId and externalTransactionId already exists under a different Idempotency-Key',
          );
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

    return this.uow.transactional(async ({ wallets, wagers }) => {
      const wallet = await wallets.findById(cmd.walletId);
      const balance = wallet ? wallet.balance : Money.zero(cmd.money.currency);
      const now = new Date();

      const tx = this.newTransaction(cmd, payloadHash, Money.from(cmd.money), now);
      tx.fail(failureCode, balance);
      await wagers.save(tx);
      await this.saveInbox(wagers, cmd, payloadHash, now);

      const failedEvent = WagerTransactionFailed.from(tx, failureCode, { correlationId: tx.id });
      await wagers.saveOutboxMessage(OutboxMessage.enqueue(failedEvent));

      this.metrics.transactionFailed(cmd.kind);

      return {
        transactionId: tx.id,
        status: WagerTransactionStatus.Failed,
        balance: balance.toJSON(),
        idempotentReplay: false,
        failureCode,
      };
    });
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
      throw new NotFoundException(`Wallet not found: ${cmd.walletId}`);
    }

    // 2. Idempotency — payload must match for every existing state,
    // including PENDING_REFERENCE (otherwise a resend could alter amount/reference).
    const existingTx = await wagers.findByIdempotencyKey(cmd.idempotencyKey);
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
        this.logger.log(`Inbox dedup: message ${cmd.sqsMessageId} already processed`);
        const existingByExt = await wagers.findByProviderAndExternalId(
          cmd.providerId,
          cmd.externalTransactionId,
        );
        if (existingByExt) {
          return {
            transactionId: existingByExt.id,
            status: existingByExt.status,
            balance: existingByExt.balanceAfter?.toJSON(),
            idempotentReplay: true,
          };
        }
      }
    }

    // 4. Currency
    if (wallet.currency !== cmd.money.currency) {
      return this.recordRejection(scope, cmd, payloadHash, wallet, FailureCode.CURRENCY_MISMATCH);
    }

    const now = new Date();
    // Resume an existing PENDING_REFERENCE transaction or create a new one in PENDING
    const wagerTx = existingTx ?? this.newTransaction(cmd, payloadHash, Money.from(cmd.money), now);
    // Always operate on the persisted values (a resumed PENDING_REFERENCE tx keeps its original amount)
    const operationMoney = wagerTx.money;

    // 5. Reference resolution
    let referenceTx: WagerTransaction | null = null;
    if (wagerTx.requiresReference()) {
      referenceTx = await wagers.findByProviderAndExternalId(
        cmd.providerId,
        wagerTx.referenceExternalTransactionId!,
      );

      if (!referenceTx) {
        // Out of order: reference not found yet -> PENDING_REFERENCE
        wagerTx.markPendingReference();
        wagerTx.scheduleRetry(now);
        await wagers.save(wagerTx);

        const pendingEvent = WagerTransactionPendingReference.from(wagerTx, { correlationId: wagerTx.id });
        await wagers.saveOutboxMessage(OutboxMessage.enqueue(pendingEvent));

        return {
          transactionId: wagerTx.id,
          status: WagerTransactionStatus.PendingReference,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };
      }

      const validationError = await this.validateReference(wagerTx, referenceTx, wagers);
      if (validationError) {
        return this.recordRejection(scope, cmd, payloadHash, wallet, validationError, wagerTx);
      }
    }

    // 6. Money movement
    let ledgerEntry: WalletLedgerEntry | undefined;
    switch (cmd.kind) {
      case WagerTransactionKind.Bet:
        if (wallet.balance.isLessThan(operationMoney)) {
          return this.recordRejection(scope, cmd, payloadHash, wallet, FailureCode.INSUFFICIENT_BALANCE, wagerTx);
        }
        ledgerEntry = wallet.debit(wagerTx.id, operationMoney, now);
        break;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund: // Refund re-credits the bet
        ledgerEntry = wallet.credit(wagerTx.id, operationMoney, now);
        break;
      case WagerTransactionKind.Loss:
        break; // No balance movement, no ledger entry
      case WagerTransactionKind.Rollback:
        // Inverse of the reference
        if (wagerTx.ledgerDirectionFor(referenceTx!) === LedgerDirection.Debit) {
          if (wallet.balance.isLessThan(operationMoney)) {
            return this.recordRejection(
              scope,
              cmd,
              payloadHash,
              wallet,
              FailureCode.REVERSAL_INSUFFICIENT_BALANCE,
              wagerTx,
            );
          }
          ledgerEntry = wallet.debit(wagerTx.id, operationMoney, now);
        } else {
          ledgerEntry = wallet.credit(wagerTx.id, operationMoney, now);
        }
        break;
    }

    // 7. Persist atomically: wallet (version-checked), ledger, transaction, inbox, outbox
    wagerTx.markProcessed(referenceTx?.id, now, wallet.balance);
    await wallets.save(wallet);
    if (ledgerEntry) {
      await wallets.saveLedgerEntry(ledgerEntry);
    }
    await wagers.save(wagerTx);
    await this.saveInbox(wagers, cmd, payloadHash, now);

    const processedEvent = WagerTransactionProcessed.from(wagerTx, { correlationId: wagerTx.id });
    await wagers.saveOutboxMessage(OutboxMessage.enqueue(processedEvent));
    if (ledgerEntry) {
      const balanceEvent = WalletBalanceChanged.from(wallet, ledgerEntry, { correlationId: wagerTx.id });
      await wagers.saveOutboxMessage(OutboxMessage.enqueue(balanceEvent));
    }

    return {
      transactionId: wagerTx.id,
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async validateReference(
    tx: WagerTransaction,
    ref: WagerTransaction,
    wagers: WagerTransactionRepositoryPort,
  ): Promise<FailureCode | null> {
    // Must be PROCESSED
    if (ref.status !== WagerTransactionStatus.Processed) {
      return FailureCode.REFERENCE_NOT_PROCESSED;
    }

    // Must belong to same provider, player, wallet, round, currency
    if (ref.providerId !== tx.providerId) return FailureCode.CROSS_PROVIDER_REFERENCE;
    if (ref.playerId !== tx.playerId) return FailureCode.CROSS_PLAYER_REFERENCE;
    if (ref.walletId !== tx.walletId) return FailureCode.CROSS_WALLET_REFERENCE;
    if (ref.roundId !== tx.roundId) return FailureCode.CROSS_ROUND_REFERENCE;
    if (ref.money.currency !== tx.money.currency) return FailureCode.CURRENCY_MISMATCH;

    // Amount must match exactly
    if (!ref.money.equals(tx.money)) {
      return FailureCode.REVERSAL_AMOUNT_MISMATCH;
    }

    // REFUND can only reference BET; ROLLBACK can reference BET, WIN or REFUND
    const allowedKinds =
      tx.kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : tx.kind === WagerTransactionKind.Rollback
          ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]
          : null;
    if (allowedKinds) {
      if (!allowedKinds.includes(ref.kind)) {
        return FailureCode.INVALID_REFERENCE_KIND;
      }
      if (await wagers.hasReversal(ref.id)) {
        return FailureCode.REFERENCE_ALREADY_REVERSED;
      }
    }

    return null;
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

    tx.reject(failureCode, wallet.balance);
    await wagers.save(tx);
    await this.saveInbox(wagers, cmd, payloadHash, now);

    const rejectedEvent = WagerTransactionRejected.from(tx, failureCode, { correlationId: tx.id });
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
      throw new BadRequestException('OPENING transactions are internal only');
    }
  }

  private recordOutcomeMetrics(kind: WagerTransactionKind, result: ProcessWagerResult, durationMs: number): void {
    const outcome = result.idempotentReplay
      ? 'idempotent_replay'
      : result.status === WagerTransactionStatus.Processed
        ? 'processed'
        : result.status === WagerTransactionStatus.Rejected
          ? 'rejected'
          : result.status === WagerTransactionStatus.PendingReference
            ? 'pending_reference'
            : 'failed';
    this.metrics.transactionCompleted(kind, outcome, durationMs, result.failureCode);
  }
}
