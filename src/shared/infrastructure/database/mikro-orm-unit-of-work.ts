import { Injectable } from '@nestjs/common';
import { OptimisticLockError } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  InfrastructureUnavailableError,
  type TransactionScope,
  UniqueViolationError,
  UnitOfWork,
} from '../../application/ports/unit-of-work.port';

/** Network-level failures of the driver socket. */
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'EAI_AGAIN']);

/**
 * PostgreSQL / driver error meaning "database unavailable right now": SQLSTATE class 08
 * (connection exception), 57P01-57P03 (shutdown / cannot connect now), 53300 (too many
 * connections), socket errors, and the pool's acquire timeout.
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (code.startsWith('08') || ['57P01', '57P02', '57P03', '53300'].includes(code)) return true;
  if (NETWORK_ERROR_CODES.has(code)) return true;
  if (e.name === 'KnexTimeoutError' || e.name === 'ConnectionException') return true;
  if (typeof e.message === 'string' && /Connection terminated|Timeout acquiring a connection/i.test(e.message)) return true;
  // AggregateError (dual-stack connect) and wrapped driver errors
  const nested = (err as { errors?: unknown[] })?.errors;
  if (Array.isArray(nested) && nested.some(isDatabaseUnavailable)) return true;
  return e.cause !== undefined && e.cause !== err ? isDatabaseUnavailable(e.cause) : false;
}
import { WalletRepository } from '../../../wallet/infrastructure/persistence/wallet.repository';
import { WagerTransactionRepository } from '../../../wagering/infrastructure/persistence/wager-transaction.repository';

/** PostgreSQL SQLSTATE -> typed application error. Anything else is rethrown unchanged. */
export function translateDbError(err: unknown): unknown {
  if (
    err instanceof ConcurrencyConflictError ||
    err instanceof UniqueViolationError ||
    err instanceof InfrastructureUnavailableError
  ) {
    return err;
  }
  if (isDatabaseUnavailable(err)) return new InfrastructureUnavailableError('postgresql', err);
  if (err instanceof OptimisticLockError) return new ConcurrencyConflictError('OPTIMISTIC_LOCK', err);

  const { code, constraint } = (err ?? {}) as { code?: string; constraint?: string };
  switch (code) {
    case '23505':
      return new UniqueViolationError(constraint, err);
    case '55P03':
      return new ConcurrencyConflictError('LOCK_TIMEOUT', err);
    case '40P01':
      return new ConcurrencyConflictError('DEADLOCK', err);
    case '40001':
      return new ConcurrencyConflictError('SERIALIZATION', err);
    default:
      return err;
  }
}

@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(private readonly em: EntityManager) {
    super();
  }

  /** Scope over an EntityManager that is already inside a transaction. */
  static scopeOf(em: EntityManager): TransactionScope {
    return {
      wallets: new WalletRepository(em),
      wagers: new WagerTransactionRepository(em),
      flush: () => em.flush(),
    };
  }

  async transactional<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      // lock_timeout is a session setting of every pooled connection (mikro-orm.config.ts)
      return await this.em.fork().transactional((em) => work(MikroOrmUnitOfWork.scopeOf(em)));
    } catch (err) {
      throw translateDbError(err);
    }
  }
}
