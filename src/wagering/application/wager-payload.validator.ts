import { WagerTransactionKind } from '../domain/wager-transaction.entity';
import { MoneyProps } from '../../shared/domain/value-objects';

/**
 * Contract validation shared by every inbound adapter (HTTP and SQS), so both reject
 * the same payloads before they reach the use case or PostgreSQL. Limits mirror the
 * `wager_transactions` schema: an out-of-contract value must be a 400 / DLQ, never a 500.
 */
export interface WagerPayload {
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

const EXTERNAL_KINDS: readonly string[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];
const REVERSAL_KINDS: readonly string[] = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_PATTERN = /^\d{1,17}\.\d{2}$/; // NUMERIC(19,2)
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const MAX_IDEMPOTENCY_KEY_LENGTH = 512;

function checkString(errors: string[], data: Record<string, unknown>, field: string, maxLength: number) {
  const value = data[field];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${field} must be a non-empty string`);
  } else if (value.length > maxLength) {
    errors.push(`${field} must have at most ${maxLength} characters`);
  }
}

/** Returns the list of contract violations (empty when valid). */
export function validateWagerPayload(input: unknown): string[] {
  if (!input || typeof input !== 'object') return ['payload must be an object'];
  const data = input as Record<string, unknown>;
  const errors: string[] = [];

  checkString(errors, data, 'providerId', 100);
  checkString(errors, data, 'externalTransactionId', 255);
  checkString(errors, data, 'roundId', 255);
  checkString(errors, data, 'gameId', 255);

  for (const field of ['playerId', 'walletId']) {
    if (typeof data[field] !== 'string' || !UUID_PATTERN.test(data[field] as string)) {
      errors.push(`${field} must be a UUID`);
    }
  }

  const kind = data.kind;
  if (typeof kind !== 'string' || !EXTERNAL_KINDS.includes(kind)) {
    errors.push(`kind must be one of ${EXTERNAL_KINDS.join(', ')}`);
  }

  const money = data.money as Record<string, unknown> | undefined;
  if (!money || typeof money !== 'object') {
    errors.push('money must be an object with amount and currency');
  } else {
    if (typeof money.amount !== 'string' || !AMOUNT_PATTERN.test(money.amount)) {
      errors.push('money.amount must be a decimal string with exactly 2 decimal places, e.g. "25.00"');
    } else if (kind !== WagerTransactionKind.Loss && /^0+\.00$/.test(money.amount)) {
      errors.push('money.amount must be greater than zero');
    }
    if (typeof money.currency !== 'string' || !CURRENCY_PATTERN.test(money.currency)) {
      errors.push('money.currency must be an ISO-4217 code, e.g. "BRL"');
    }
  }

  // Required for reversals; optional informational link for other kinds (e.g. WIN -> BET)
  const ref = data.referenceExternalTransactionId;
  if ((typeof kind === 'string' && REVERSAL_KINDS.includes(kind)) || (ref !== undefined && ref !== null)) {
    checkString(errors, data, 'referenceExternalTransactionId', 255);
  }

  return errors;
}
