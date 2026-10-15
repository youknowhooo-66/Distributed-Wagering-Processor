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
import {
  ConcurrencyConflictError,
  InfrastructureUnavailableError,
} from '../../application/ports/unit-of-work.port';
import { isDatabaseUnavailable } from '../database/mikro-orm-unit-of-work';

/** Machine-readable code used when an HTTP exception did not set one. */
const DEFAULT_CODE_BY_STATUS: Record<number, string> = {
  400: 'INVALID_PAYLOAD',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

const MACHINE_CODE = /^[A-Z][A-Z0-9_]+$/;

/** Domain errors that are contract problems (400) or conflicts (409); the rest are 422. */
const DOMAIN_STATUS: Record<string, number> = {
  INVALID_MONEY: HttpStatus.BAD_REQUEST,
  MISSING_REFERENCE: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  WALLET_ALREADY_EXISTS: HttpStatus.CONFLICT,
  WALLET_NOT_FOUND: HttpStatus.NOT_FOUND,
};

/**
 * Every error leaves the API with the same envelope — `{ statusCode, error, message }`, where
 * `error` is a stable machine-readable code — so a provider decides on the status code and the
 * code, never on free text:
 * 400 contract · 404 not found · 409 conflict · 413/415 transport · 422 business rule ·
 * 503 + Retry-After transient · 500 unexpected (no internal details, logged with correlationId).
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const req = ctx.getRequest<{ id?: unknown; method?: string; url?: string }>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const body = typeof res === 'object' && res !== null ? (res as Record<string, unknown>) : { message: res };
      if (status === HttpStatus.SERVICE_UNAVAILABLE) response.setHeader('Retry-After', '1');
      return response.status(status).json({
        statusCode: status,
        error: this.codeOf(body.error, status),
        message: body.message ?? exception.message,
      });
    }

    if (exception instanceof DomainError) {
      const status = DOMAIN_STATUS[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY;
      return response.status(status).json({
        statusCode: status,
        error: exception.code,
        message: exception.message,
      });
    }

    // Transient infrastructure failure: the provider may retry the same request (same key)
    if (
      exception instanceof InfrastructureUnavailableError ||
      exception instanceof ConcurrencyConflictError ||
      isDatabaseUnavailable(exception)
    ) {
      this.logger.warn({
        msg: 'transient infrastructure failure',
        correlationId: req?.id,
        error: (exception as Error)?.message,
      });
      response.setHeader('Retry-After', '1');
      return response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'SERVICE_UNAVAILABLE',
        message: 'A dependency is temporarily unavailable; retry with the same Idempotency-Key',
      });
    }

    // Client errors raised by the HTTP stack before Nest (body-parser: body too large,
    // unsupported charset, malformed JSON): http-errors carry a 4xx `status` and `expose`
    const clientStatus = this.clientErrorStatus(exception);
    if (clientStatus !== undefined) {
      const type = (exception as { type?: unknown }).type;
      return response.status(clientStatus).json({
        statusCode: clientStatus,
        error: type === 'entity.parse.failed' ? 'INVALID_JSON' : this.codeOf(undefined, clientStatus),
        message: (exception as Error).message,
      });
    }

    const err = exception as Error;
    this.logger.error({
      msg: 'unhandled internal exception',
      correlationId: req?.id,
      method: req?.method,
      path: req?.url?.split('?')[0],
      error: err?.message,
      stack: err?.stack,
    });
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  }

  private codeOf(candidate: unknown, status: number): string {
    if (typeof candidate === 'string' && MACHINE_CODE.test(candidate)) return candidate;
    return DEFAULT_CODE_BY_STATUS[status] ?? `HTTP_${status}`;
  }

  private clientErrorStatus(exception: unknown): number | undefined {
    const e = (exception ?? {}) as { status?: unknown; statusCode?: unknown; expose?: unknown };
    const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
    return status !== undefined && status >= 400 && status < 500 && e.expose === true ? status : undefined;
  }
}
