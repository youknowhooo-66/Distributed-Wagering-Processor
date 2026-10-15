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
