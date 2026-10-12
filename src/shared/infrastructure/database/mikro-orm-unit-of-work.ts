import { Injectable } from '@nestjs/common';
import { OptimisticLockError } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  type TransactionScope,
  UniqueViolationError,
  UnitOfWork,
} from '../../application/ports/unit-of-work.port';
import { WalletRepository } from '../../../wallet/infrastructure/persistence/wallet.repository';
import { WagerTransactionRepository } from '../../../wagering/infrastructure/persistence/wager-transaction.repository';

const LOCK_TIMEOUT_PATTERN = /^\d+(ms|s)?$/;

/** PostgreSQL SQLSTATE -> typed application error. Anything else is rethrown unchanged. */
export function translateDbError(err: unknown): unknown {
  if (err instanceof ConcurrencyConflictError || err instanceof UniqueViolationError) return err;
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
  private readonly lockTimeout: string;

  constructor(private readonly em: EntityManager) {
    super();
    const configured = process.env.DB_LOCK_TIMEOUT_MS || '5000ms';
    // Validated because SET LOCAL does not accept bind parameters
    if (!LOCK_TIMEOUT_PATTERN.test(configured)) {
      throw new Error(`Invalid DB_LOCK_TIMEOUT_MS: "${configured}" (expected e.g. "5000ms")`);
    }
    this.lockTimeout = configured;
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
      return await this.em.fork().transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = '${this.lockTimeout}'`);
        return work(MikroOrmUnitOfWork.scopeOf(em));
      });
    } catch (err) {
      throw translateDbError(err);
    }
  }
}
