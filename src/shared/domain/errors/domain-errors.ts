/**
 * Base class for domain errors.
 * All domain-specific errors extend this class so they can be caught
 * and mapped to appropriate HTTP responses at the controller layer.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(reason: string) {
    super(`Invalid money value: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';

  constructor(walletId: string, balance: string, requested: string) {
    super(
      `Insufficient balance in wallet ${walletId}: balance=${balance}, requested=${requested}`,
    );
  }
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(
      `Wallet already exists for player ${playerId} with currency ${currency}`,
    );
  }
}

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet not found: ${walletId}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(transactionId: string, currentStatus: string, attemptedTransition: string) {
    super(
      `Cannot transition transaction ${transactionId} from ${currentStatus} to ${attemptedTransition}: current status is terminal`,
    );
  }
}

export class MissingReferenceError extends DomainError {
  readonly code = 'MISSING_REFERENCE';

  constructor(kind: string) {
    super(`${kind} transactions require a referenceExternalTransactionId`);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';

  constructor(reason: string) {
    super(`Invalid ledger entry: ${reason}`);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(
      `Idempotency conflict: key "${idempotencyKey}" already used with a different payload`,
    );
  }
}

export class ReferenceNotFoundError extends DomainError {
  readonly code = 'REFERENCE_NOT_FOUND';

  constructor(providerId: string, externalTransactionId: string) {
    super(
      `Reference transaction not found: provider=${providerId}, externalTxId=${externalTransactionId}`,
    );
  }
}

export class ReferenceAlreadyReversedError extends DomainError {
  readonly code = 'REFERENCE_ALREADY_REVERSED';

  constructor(referenceId: string, reversalKind: string) {
    super(
      `Reference ${referenceId} has already been reversed by a ${reversalKind}`,
    );
  }
}

export class InvalidReferenceKindError extends DomainError {
  readonly code = 'INVALID_REFERENCE_KIND';

  constructor(operationKind: string, referenceKind: string) {
    super(
      `${operationKind} cannot reference a ${referenceKind} transaction`,
    );
  }
}

export class ReversalAmountMismatchError extends DomainError {
  readonly code = 'REVERSAL_AMOUNT_MISMATCH';

  constructor(expected: string, received: string) {
    super(
      `Reversal amount mismatch: reference amount=${expected}, reversal amount=${received}`,
    );
  }
}

export class CrossEntityReferenceError extends DomainError {
  readonly code: string;

  constructor(field: string, expected: string, received: string) {
    super(
      `Cross-${field} reference: expected ${expected}, received ${received}`,
    );
    this.code = `CROSS_${field.toUpperCase()}_REFERENCE`;
  }
}
