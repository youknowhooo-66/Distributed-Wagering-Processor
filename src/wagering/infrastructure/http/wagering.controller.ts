import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { GetTransactionUseCase } from '../../application/use-cases/get-transaction.use-case';
import { NoopAuthGuard } from '../../../shared/application/ports/auth.guard';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.entity';
import { MoneyProps } from '../../../shared/domain/value-objects';
import { IdempotencyConflictError } from '../../../shared/domain/errors';
import { invalidPayload, parseUuidParam } from '../../../shared/application/request-validation';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  validateWagerPayload,
} from '../../application/wager-payload.validator';

/** Request id assigned by pino-http (X-Correlation-Id when the caller sent a valid one). */
function correlationIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return id === undefined || id === null || id === '' ? undefined : String(id);
}

export interface SubmitTransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

@Controller()
@UseGuards(NoopAuthGuard)
export class WageringController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly getTransactionUseCase: GetTransactionUseCase,
  ) {}

  /**
   * HTTP status by outcome (same mapping everywhere, see ARCHITECTURE.md "Mapeamento de Status HTTP"):
   * 200 PROCESSED · 202 PENDING_REFERENCE · 422 REJECTED (business rule, terminal) ·
   * 400 invalid payload/header · 409 idempotency conflict · 404 wallet not found ·
   * 503 + Retry-After transient (lock contention / infrastructure) · 500 FAILED (terminal).
   * Replays keep the status of the original outcome, with idempotentReplay: true.
   */
  @Post('wagering/transactions')
  async submitTransaction(
    @Body() body: SubmitTransactionBody,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // The header is mandatory and is the source of truth (recommended: providerId:externalTransactionId)
    const idempotencyKey = idempotencyKeyHeader?.trim();
    if (!idempotencyKey) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required (recommended: "{providerId}:{externalTransactionId}")',
      });
    }
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: `Idempotency-Key must have at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      });
    }

    const violations = validateWagerPayload(body);
    if (violations.length > 0) {
      throw invalidPayload(violations);
    }

    try {
      const result = await this.processWagerUseCase.execute({
        providerId: body.providerId,
        externalTransactionId: body.externalTransactionId,
        playerId: body.playerId,
        walletId: body.walletId,
        roundId: body.roundId,
        gameId: body.gameId,
        kind: body.kind,
        money: { amount: body.money.amount, currency: body.money.currency },
        referenceExternalTransactionId: body.referenceExternalTransactionId ?? undefined,
        idempotencyKey,
        correlationId: correlationIdOf(req),
      });

      switch (result.status) {
        case WagerTransactionStatus.PendingReference:
          return res.status(HttpStatus.ACCEPTED).json(result);
        case WagerTransactionStatus.Rejected:
          return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(result);
        case WagerTransactionStatus.Failed:
          // Permanent processing failure recorded earlier (e.g. by the SQS consumer): terminal
          return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(result);
        default:
          return res.status(HttpStatus.OK).json(result);
      }
    } catch (err: any) {
      if (err instanceof IdempotencyConflictError) {
        return res.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          error: err.code,
          message: err.message,
        });
      }
      if (err?.status === HttpStatus.SERVICE_UNAVAILABLE || err?.name === 'ServiceUnavailableException') {
        res.setHeader('Retry-After', '1');
        return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          error: 'CONCURRENCY_LIMIT_EXCEEDED',
          message: err.message || 'Concurrency limit exceeded on wallet modification',
        });
      }
      throw err;
    }
  }

  @Get('wagering/transactions/:transactionId')
  async getTransaction(@Param('transactionId') transactionId: string) {
    return this.getTransactionUseCase.executeById(parseUuidParam(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getTransactionByExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.getTransactionUseCase.executeByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
