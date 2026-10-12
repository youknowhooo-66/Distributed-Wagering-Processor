import type { WalletRepositoryPort } from '../../../wallet/domain/wallet.repository.port';
import type { WagerTransactionRepositoryPort } from '../../../wagering/domain/wager-transaction.repository.port';

/** Repositories bound to one database transaction. */
export interface TransactionScope {
  readonly wallets: WalletRepositoryPort;
  readonly wagers: WagerTransactionRepositoryPort;
  /** Writes pending changes now (e.g. a parent row before rows referencing it). */
  flush(): Promise<void>;
}

/**
 * Application port for atomic work. The adapter owns transaction demarcation, lock
 * timeouts and translation of driver errors into the typed errors below, so use cases
 * never depend on the ORM or on database error messages.
 */
export abstract class UnitOfWork {
  /** Runs `work` in a new transaction: commit when it resolves, rollback when it throws. */
  abstract transactional<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

/** Retryable: optimistic version mismatch, lock timeout, deadlock or serialization failure. */
export class ConcurrencyConflictError extends Error {
  constructor(
    readonly reason: 'OPTIMISTIC_LOCK' | 'LOCK_TIMEOUT' | 'DEADLOCK' | 'SERIALIZATION',
    cause?: unknown,
  ) {
    super(`Concurrency conflict: ${reason}`, { cause });
    this.name = 'ConcurrencyConflictError';
  }
}

/** A unique constraint or unique index rejected the write. */
export class UniqueViolationError extends Error {
  constructor(
    readonly constraint: string | undefined,
    cause?: unknown,
  ) {
    super(`Unique constraint violated: ${constraint ?? 'unknown'}`, { cause });
    this.name = 'UniqueViolationError';
  }
}
