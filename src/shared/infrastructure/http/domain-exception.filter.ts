import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../../domain/errors/domain-errors';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      return response.status(status).json(
        typeof res === 'object' ? res : { statusCode: status, message: res },
      );
    }

    if (exception instanceof DomainError) {
      let status = HttpStatus.UNPROCESSABLE_ENTITY; // 422 default for business violations

      switch (exception.code) {
        case 'INVALID_MONEY':
          status = HttpStatus.BAD_REQUEST;
          break;
        case 'IDEMPOTENCY_CONFLICT':
        case 'WALLET_ALREADY_EXISTS':
          status = HttpStatus.CONFLICT;
          break;
        case 'WALLET_NOT_FOUND':
        case 'REFERENCE_NOT_FOUND':
          status = HttpStatus.NOT_FOUND;
          break;
        case 'INSUFFICIENT_BALANCE':
        case 'CURRENCY_MISMATCH':
        case 'INVALID_TRANSACTION_STATE':
        case 'REFERENCE_ALREADY_REVERSED':
        case 'INVALID_REFERENCE_KIND':
        case 'REVERSAL_AMOUNT_MISMATCH':
        case 'CROSS_PROVIDER_REFERENCE':
        case 'CROSS_PLAYER_REFERENCE':
        case 'CROSS_ROUND_REFERENCE':
        case 'CROSS_WALLET_REFERENCE':
          status = HttpStatus.UNPROCESSABLE_ENTITY;
          break;
        default:
          status = HttpStatus.UNPROCESSABLE_ENTITY;
      }

      return response.status(status).json({
        statusCode: status,
        error: exception.code,
        message: exception.message,
      });
    }

    const err = exception as Error;
    this.logger.error(`Unhandled internal exception: ${err.message}`, err.stack);
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
