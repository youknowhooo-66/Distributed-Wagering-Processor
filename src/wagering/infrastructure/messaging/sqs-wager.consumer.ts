import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  HttpException,
} from '@nestjs/common';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../../shared/infrastructure/messaging/sqs.client';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  validateWagerPayload,
} from '../../application/wager-payload.validator';
import { WagerTransactionKind } from '../../domain/wager-transaction.entity';
import { MoneyProps } from '../../../shared/domain/value-objects';
import { DomainError } from '../../../shared/domain/errors';
import { FailureCode } from '../../../shared/domain/errors/failure-codes';
import { generateId } from '../../../shared/domain/identifier';
import { retryAttemptsTotal, dlqMessagesTotal } from '../../../shared/infrastructure/metrics/metrics.controller';

export interface SqsWagerMessageEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
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
  };
}

/** Receives after which a transient (non-contention) failure is sent to the DLQ. */
const MAX_TRANSIENT_RECEIVES = 5;
/**
 * Lock contention is expected to clear, so it gets a larger budget. Must stay below the
 * queue's RedrivePolicy maxReceiveCount so the app (not SQS) records FAILED and moves it.
 */
const MAX_CONTENTION_RECEIVES = 10;

@Injectable()
export class SqsWagerConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private sqsClient!: SQSClient;
  private isRunning = false;
  private activeProcessingCount = 0;
  private queueUrl =
    process.env.SQS_WAGER_QUEUE_URL ||
    'http://localhost:4566/000000000000/wager-transactions.fifo';
  private dlqUrl =
    process.env.SQS_WAGER_DLQ_URL ||
    'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
  private readonly consumerName = process.env.CONSUMER_NAME || 'wager-transactions-consumer';

  // Only injectable dependencies here: any extra primitive parameter is emitted
  // as `String` in design:paramtypes and breaks Nest DI at bootstrap.
  constructor(private readonly processWagerUseCase: ProcessWagerTransactionUseCase) {}

  onModuleInit() {
    this.sqsClient = createSqsClient();
    this.isRunning = true;
    if (process.env.ENABLE_BACKGROUND_POLL !== 'false') {
      this.startConsumerLoop();
    }
  }

  async onModuleDestroy() {
    this.logger.log('SIGTERM received: shutting down SQS consumer gracefully...');
    this.isRunning = false;

    // Grace period for active messages to finish
    const startWait = Date.now();
    while (this.activeProcessingCount > 0 && Date.now() - startWait < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async startConsumerLoop() {
    while (this.isRunning) {
      try {
        await this.pollMessages();
      } catch (err) {
        this.logger.error(`SQS consumer polling error: ${err}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async pollMessages(): Promise<void> {
    const response = await this.sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2, // Short wait for local / tests
        VisibilityTimeout: 30,
        AttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );

    if (!response.Messages || response.Messages.length === 0) {
      return;
    }

    // Groups whose head message stayed in the queue in this batch: later messages of the
    // same group must not be processed before it, or per-wallet FIFO order is broken.
    const blockedGroups = new Set<string>();

    for (let i = 0; i < response.Messages.length; i++) {
      const msg = response.Messages[i];
      if (!msg) continue;
      if (!this.isRunning) {
        // Return remaining unconsumed messages in the batch immediately with visibility 0
        for (let j = i; j < response.Messages.length; j++) {
          const unconsumed = response.Messages[j];
          if (unconsumed?.ReceiptHandle) {
            this.releaseMessage(unconsumed.ReceiptHandle).catch(() => {});
          }
        }
        break;
      }
      if (!msg.Body || !msg.ReceiptHandle) continue;

      const groupId = msg.Attributes?.MessageGroupId;
      if (groupId && blockedGroups.has(groupId)) {
        this.logger.warn(
          `Deferring message ${msg.MessageId}: an earlier message of group ${groupId} is pending retry`,
        );
        await this.releaseMessage(msg.ReceiptHandle).catch(() => {});
        continue;
      }

      this.activeProcessingCount++;
      try {
        const removedFromQueue = await this.handleMessage(msg);
        if (!removedFromQueue && groupId) blockedGroups.add(groupId);
      } finally {
        this.activeProcessingCount--;
      }
    }
  }

  /**
   * Processes one message. Returns true when it left the main queue (ACK or DLQ),
   * false when it stays there for a later retry.
   */
  private async handleMessage(msg: Message): Promise<boolean> {
    const body = msg.Body!;
    const receiptHandle = msg.ReceiptHandle!;
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount || '1');

    let envelope: SqsWagerMessageEnvelope;
    try {
      envelope = JSON.parse(body);
    } catch {
      // Permanent error: Malformed JSON -> send directly to DLQ and remove from main queue
      this.logger.error(`Permanent error: Malformed JSON in SQS message ${msg.MessageId}`);
      return this.forwardToDlqAndAck(body, receiptHandle, msg.MessageId, undefined, 'MALFORMED_JSON');
    }

    const violations = this.contractViolations(envelope);
    if (violations.length > 0) {
      this.logger.error(
        `Permanent error: Invalid contract in SQS message ${msg.MessageId}: ${violations.join('; ')}`,
      );
      return this.forwardToDlqAndAck(
        body,
        receiptHandle,
        msg.MessageId,
        (envelope as Partial<SqsWagerMessageEnvelope> | undefined)?.data?.walletId,
        'INVALID_CONTRACT',
      );
    }

    try {
      await this.processWagerUseCase.execute(this.toCommand(envelope));
    } catch (error: unknown) {
      return this.handleProcessingError(error, msg, envelope, receiveCount);
    }

    // Ack after commit. If the delete fails the message is redelivered and absorbed by inbox dedup.
    await this.sqsClient.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }),
    );
    return true;
  }

  private async handleProcessingError(
    error: unknown,
    msg: Message,
    envelope: SqsWagerMessageEnvelope,
    receiveCount: number,
  ): Promise<boolean> {
    const err = error as Error;
    this.logger.error(`Failed processing SQS message ${msg.MessageId}: ${err?.message}`);

    // Permanent: domain errors (e.g. idempotency conflict) and 4xx (wallet not found,
    // provider/external id collision). Retrying cannot succeed -> DLQ for inspection.
    const status = error instanceof HttpException ? error.getStatus() : undefined;
    if (error instanceof DomainError || (status !== undefined && status < 500)) {
      const reason = error instanceof DomainError ? error.code : `HTTP_${status}`;
      return this.forwardToDlqAndAck(msg.Body!, msg.ReceiptHandle!, msg.MessageId, envelope.data.walletId, reason);
    }

    const isContentionError = this.isContentionError(err);
    retryAttemptsTotal.inc({ type: isContentionError ? 'lock_contention' : 'sqs_transient_error' });

    const maxReceives = isContentionError ? MAX_CONTENTION_RECEIVES : MAX_TRANSIENT_RECEIVES;
    if (receiveCount >= maxReceives) {
      this.logger.error(
        `Message ${msg.MessageId} exceeded max receives (${receiveCount} >= ${maxReceives}). Forwarding to DLQ.`,
      );
      try {
        await this.processWagerUseCase.recordFailure(
          this.toCommand(envelope),
          FailureCode.PERMANENT_PROCESSING_ERROR,
        );
      } catch (recErr) {
        this.logger.error(`Failed to record FAILED transaction state: ${(recErr as Error).message}`);
      }
      return this.forwardToDlqAndAck(
        msg.Body!,
        msg.ReceiptHandle!,
        msg.MessageId,
        envelope.data.walletId,
        isContentionError ? 'MAX_CONTENTION_RECEIVES' : 'MAX_TRANSIENT_RECEIVES',
      );
    }

    // Transient error or lock contention -> exponential backoff: min(5 * 2^receiveCount, 300) seconds
    await this.setVisibility(msg.ReceiptHandle!, Math.min(5 * Math.pow(2, Math.min(receiveCount, 6)), 300));
    return false;
  }

  private isContentionError(err: Error): boolean {
    const msg = err?.message?.toLowerCase() || '';
    return (
      (err as any)?.status === 503 ||
      (err as any)?.name === 'ServiceUnavailableException' ||
      msg.includes('concurrency limit exceeded') ||
      msg.includes('lock timeout') ||
      msg.includes('deadlock detected') ||
      msg.includes('could not serialize access') ||
      msg.includes('optimisticlockerror')
    );
  }

  private contractViolations(envelope: unknown): string[] {
    if (!envelope || typeof envelope !== 'object') return ['envelope must be an object'];
    const env = envelope as Partial<SqsWagerMessageEnvelope>;
    const violations: string[] = [];
    if (typeof env.messageId !== 'string' || env.messageId.trim() === '') {
      violations.push('messageId must be a non-empty string');
    }
    const key = env.data?.idempotencyKey;
    if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      violations.push(`data.idempotencyKey must be a non-empty string up to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
    }
    return [...violations, ...validateWagerPayload(env.data).map((v) => `data.${v}`)];
  }

  private toCommand(envelope: SqsWagerMessageEnvelope) {
    return {
      providerId: envelope.data.providerId,
      externalTransactionId: envelope.data.externalTransactionId,
      idempotencyKey: envelope.data.idempotencyKey,
      playerId: envelope.data.playerId,
      walletId: envelope.data.walletId,
      roundId: envelope.data.roundId,
      gameId: envelope.data.gameId,
      kind: envelope.data.kind,
      money: envelope.data.money,
      referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
      sqsMessageId: envelope.messageId,
      consumerName: this.consumerName,
    };
  }

  private releaseMessage(receiptHandle: string): Promise<unknown> {
    return this.sqsClient.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  private async setVisibility(receiptHandle: string, seconds: number): Promise<void> {
    try {
      await this.sqsClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (visErr) {
      this.logger.warn(`Failed to change message visibility: ${(visErr as Error).message}`);
    }
  }

  /**
   * Moves a message to the DLQ. The original is deleted from the main queue only after the
   * DLQ accepted it; otherwise it stays (and is retried) so it is never lost.
   * Returns true when the message left the main queue.
   */
  private async forwardToDlqAndAck(
    body: string,
    receiptHandle: string,
    messageId?: string,
    walletId?: string,
    reason = 'UNSPECIFIED',
  ): Promise<boolean> {
    try {
      await this.sqsClient.send(
        new SendMessageCommand({
          QueueUrl: this.dlqUrl,
          MessageBody: body,
          MessageGroupId: walletId || 'poison-messages',
          MessageDeduplicationId: messageId || generateId(),
          MessageAttributes: {
            FailureReason: { DataType: 'String', StringValue: reason },
          },
        }),
      );
    } catch (dlqErr) {
      this.logger.error(
        `Failed forwarding message ${messageId} to DLQ; keeping it in the main queue: ${dlqErr}`,
      );
      await this.setVisibility(receiptHandle, 30);
      return false;
    }
    dlqMessagesTotal.inc();

    try {
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    } catch (deleteErr) {
      // The DLQ copy is deduplicated by MessageDeduplicationId if this message is redelivered
      this.logger.error(`Failed deleting message ${messageId} from main queue after DLQ: ${deleteErr}`);
    }
    return true;
  }
}
