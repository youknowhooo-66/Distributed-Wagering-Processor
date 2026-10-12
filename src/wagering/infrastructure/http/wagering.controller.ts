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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { GetTransactionUseCase } from '../../application/use-cases/get-transaction.use-case';
import { NoopAuthGuard } from '../../../shared/application/ports/auth.guard';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.entity';
import { MoneyProps } from '../../../shared/domain/value-objects';
import { IdempotencyConflictError } from '../../../shared/domain/errors';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  validateWagerPayload,
} from '../../application/wager-payload.validator';

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

  @Post('wagering/transactions')
  async submitTransaction(
    @Body() body: SubmitTransactionBody,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Res() res: Response,
  ) {
    const violations = validateWagerPayload(body);
    if (violations.length > 0) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'INVALID_PAYLOAD',
        message: violations,
      });
    }

    // Without the header, the provider's natural key (providerId:externalTransactionId) is used
    const idempotencyKey =
      idempotencyKeyHeader?.trim() || `${body.providerId}:${body.externalTransactionId}`;
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new BadRequestException(
        `Idempotency-Key must have at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      );
    }

    try {
      const result = await this.processWagerUseCase.execute({
        ...body,
        idempotencyKey,
      });

      // HTTP Status Mapping
      if (result.status === WagerTransactionStatus.PendingReference) {
        return res.status(HttpStatus.ACCEPTED).json(result);
      }

      if (result.status === WagerTransactionStatus.Rejected) {
        return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(result);
      }

      return res.status(HttpStatus.OK).json(result);
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
          message: err.message || 'Concurrency limit exceeded on wallet modification',
        });
      }
      throw err;
    }
  }

  @Get('wagering/transactions/:transactionId')
  async getTransaction(@Param('transactionId') transactionId: string) {
    return this.getTransactionUseCase.executeById(transactionId);
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
