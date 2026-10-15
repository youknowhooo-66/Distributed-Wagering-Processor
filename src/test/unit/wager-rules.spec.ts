import { describe, it, expect } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction.entity';
import { checkReference, checkWalletOwnership, checkWinReference, settle } from '../../wagering/domain/wager-rules';
import { Wallet } from '../../wallet/domain/wallet.entity';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry.entity';
import { Money } from '../../shared/domain/value-objects';
import { FailureCode, MissingReferenceError } from '../../shared/domain/errors';
import { generateId } from '../../shared/domain/identifier';

/**
 * Section 7 rules tested against the production code (src/wagering/domain/wager-rules.ts),
 * which the use case calls — no copy of the logic lives in the test.
 */

const at = new Date('2026-07-29T15:00:00.000Z');
const PLAYER = 'player-1';
const WALLET = 'wallet-1';

type TxOverrides = Partial<{
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  currency: string;
  amount: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
}>;

function tx(overrides: TxOverrides = {}): WagerTransaction {
  const id = generateId();
  return WagerTransaction.rehydrate({
    id,
    providerId: overrides.providerId ?? 'prov-A',
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `idem-${id}`,
    payloadHash: 'hash',
    walletId: overrides.walletId ?? WALLET,
    playerId: overrides.playerId ?? PLAYER,
    roundId: overrides.roundId ?? 'round-1',
    gameId: 'game-1',
    kind: overrides.kind ?? WagerTransactionKind.Bet,
    moneyAmount: overrides.amount ?? '50.00',
    moneyCurrency: overrides.currency ?? 'BRL',
    referenceExternalTransactionId:
      overrides.kind === WagerTransactionKind.Refund || overrides.kind === WagerTransactionKind.Rollback
        ? 'ext-ref'
        : undefined,
    status: overrides.status ?? WagerTransactionStatus.Processed,
    createdAt: at,
    retryCount: 0,
  });
}

function wallet(balance: string, currency = 'BRL'): Wallet {
  return Wallet.rehydrate({
    id: WALLET,
    playerId: PLAYER,
    currency,
    balanceAmount: balance,
    version: 3,
    createdAt: at,
    updatedAt: at,
  });
}

const refund = (o: TxOverrides = {}) => tx({ kind: WagerTransactionKind.Refund, status: WagerTransactionStatus.Pending, ...o });
const rollback = (o: TxOverrides = {}) => tx({ kind: WagerTransactionKind.Rollback, status: WagerTransactionStatus.Pending, ...o });

describe('checkReference (rules 2–5 + out-of-order chains)', () => {
  it('REFUND of a PROCESSED BET with the same context is valid', () => {
    expect(checkReference(refund(), tx({ kind: WagerTransactionKind.Bet }), false)).toEqual({ outcome: 'VALID' });
  });

  it.each([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund])(
    'ROLLBACK of a PROCESSED %s is valid',
    (kind) => {
      expect(checkReference(rollback(), tx({ kind }), false)).toEqual({ outcome: 'VALID' });
    },
  );

  it.each([
    ['REFUND -> WIN', refund(), WagerTransactionKind.Win],
    ['REFUND -> LOSS', refund(), WagerTransactionKind.Loss],
    ['REFUND -> REFUND', refund(), WagerTransactionKind.Refund],
    ['ROLLBACK -> LOSS', rollback(), WagerTransactionKind.Loss],
    ['ROLLBACK -> ROLLBACK', rollback(), WagerTransactionKind.Rollback],
  ] as const)('INVALID_REFERENCE_KIND: %s', (_label, reversal, refKind) => {
    expect(checkReference(reversal, tx({ kind: refKind }), false)).toEqual({
      outcome: 'REJECT',
      failureCode: FailureCode.INVALID_REFERENCE_KIND,
    });
  });

  it.each([
    ['provider', { providerId: 'prov-B' }, FailureCode.CROSS_PROVIDER_REFERENCE],
    ['player', { playerId: 'player-2' }, FailureCode.CROSS_PLAYER_REFERENCE],
    ['wallet', { walletId: 'wallet-2' }, FailureCode.CROSS_WALLET_REFERENCE],
    ['round', { roundId: 'round-2' }, FailureCode.CROSS_ROUND_REFERENCE],
    ['currency', { currency: 'USD' }, FailureCode.CURRENCY_MISMATCH],
    ['amount (partial reversal)', { amount: '10.00' }, FailureCode.REVERSAL_AMOUNT_MISMATCH],
  ] as const)('rejects a reference with a different %s', (_label, refOverrides, code) => {
    const reference = tx({ kind: WagerTransactionKind.Bet, ...refOverrides });
    expect(checkReference(refund(), reference, false)).toEqual({ outcome: 'REJECT', failureCode: code });
  });

  it('REFERENCE_ALREADY_REVERSED: a reference can be reversed only once', () => {
    expect(checkReference(refund(), tx({ kind: WagerTransactionKind.Bet }), true)).toEqual({
      outcome: 'REJECT',
      failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
    });
    expect(checkReference(rollback(), tx({ kind: WagerTransactionKind.Bet }), true)).toEqual({
      outcome: 'REJECT',
      failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
    });
  });

  it.each([WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed])(
    'REFERENCE_NOT_PROCESSED when the reference ended %s',
    (status) => {
      expect(checkReference(refund(), tx({ kind: WagerTransactionKind.Bet, status }), false)).toEqual({
        outcome: 'REJECT',
        failureCode: FailureCode.REFERENCE_NOT_PROCESSED,
      });
    },
  );

  it.each([WagerTransactionStatus.PendingReference, WagerTransactionStatus.Pending])(
    'WAIT when the reference matches but is still %s (chained out-of-order reversals)',
    (status) => {
      const pendingRefund = tx({ kind: WagerTransactionKind.Refund, status });
      expect(checkReference(rollback(), pendingRefund, false)).toEqual({ outcome: 'WAIT' });
    },
  );

  it('a context mismatch is rejected immediately even while the reference is waiting', () => {
    const pendingRefund = tx({ kind: WagerTransactionKind.Refund, status: WagerTransactionStatus.PendingReference, roundId: 'other' });
    expect(checkReference(rollback(), pendingRefund, false)).toEqual({
      outcome: 'REJECT',
      failureCode: FailureCode.CROSS_ROUND_REFERENCE,
    });
  });
});

describe('settle (section 7 table)', () => {
  it('BET debits and produces one DEBIT entry', () => {
    const w = wallet('100.00');
    const bet = tx({ kind: WagerTransactionKind.Bet, amount: '25.00', status: WagerTransactionStatus.Pending });
    const result = settle(bet, w, null, at);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.entry?.direction).toBe(LedgerDirection.Debit);
    expect(result.entry?.balanceAfter.amount).toBe('75.00');
    expect(result.entry?.walletVersion).toBe(4);
    expect(w.balance.amount).toBe('75.00');
    expect(w.version).toBe(4);
  });

  it('BET above the balance is not applied: INSUFFICIENT_BALANCE and the wallet is untouched', () => {
    const w = wallet('20.00');
    const result = settle(tx({ kind: WagerTransactionKind.Bet, amount: '80.00' }), w, null, at);
    expect(result).toEqual({ applied: false, failureCode: FailureCode.INSUFFICIENT_BALANCE });
    expect(w.balance.amount).toBe('20.00');
    expect(w.version).toBe(3);
  });

  it('BET of exactly the balance leaves zero (never negative)', () => {
    const w = wallet('80.00');
    const result = settle(tx({ kind: WagerTransactionKind.Bet, amount: '80.00' }), w, null, at);
    expect(result.applied).toBe(true);
    expect(w.balance.amount).toBe('0.00');
  });

  it('WIN credits and produces one CREDIT entry', () => {
    const w = wallet('10.00');
    const result = settle(tx({ kind: WagerTransactionKind.Win, amount: '40.00' }), w, null, at);
    expect(result.applied && result.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('50.00');
  });

  it('LOSS is applied without moving money: no entry, version unchanged', () => {
    const w = wallet('10.00');
    const result = settle(tx({ kind: WagerTransactionKind.Loss, amount: '40.00' }), w, null, at);
    expect(result).toEqual({ applied: true });
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(3);
  });

  it('REFUND credits the bet back', () => {
    const w = wallet('75.00');
    const result = settle(refund({ amount: '25.00' }), w, tx({ kind: WagerTransactionKind.Bet, amount: '25.00' }), at);
    expect(result.applied && result.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('100.00');
  });

  it('ROLLBACK of a BET credits (inverse of DEBIT)', () => {
    const w = wallet('75.00');
    const result = settle(rollback({ amount: '25.00' }), w, tx({ kind: WagerTransactionKind.Bet, amount: '25.00' }), at);
    expect(result.applied && result.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('100.00');
  });

  it.each([WagerTransactionKind.Win, WagerTransactionKind.Refund])('ROLLBACK of a %s debits (inverse of CREDIT)', (kind) => {
    const w = wallet('100.00');
    const result = settle(rollback({ amount: '30.00' }), w, tx({ kind, amount: '30.00' }), at);
    expect(result.applied && result.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('70.00');
  });

  it('ROLLBACK that would make the balance negative: REVERSAL_INSUFFICIENT_BALANCE (distinct from BET)', () => {
    const w = wallet('10.00');
    const result = settle(rollback({ amount: '30.00' }), w, tx({ kind: WagerTransactionKind.Win, amount: '30.00' }), at);
    expect(result).toEqual({ applied: false, failureCode: FailureCode.REVERSAL_INSUFFICIENT_BALANCE });
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(3);
  });

  it('a currency different from the wallet is refused by the aggregate', () => {
    const w = wallet('100.00');
    expect(() => settle(tx({ kind: WagerTransactionKind.Win, currency: 'USD' }), w, null, at)).toThrow('Currency mismatch');
  });
});

describe('checkWalletOwnership', () => {
  it('accepts the owner in the wallet currency', () => {
    expect(checkWalletOwnership({ playerId: PLAYER, currency: 'BRL' }, wallet('1.00'))).toBeNull();
  });
  it('WALLET_PLAYER_MISMATCH for another player', () => {
    expect(checkWalletOwnership({ playerId: 'intruder', currency: 'BRL' }, wallet('1.00'))).toBe(
      FailureCode.WALLET_PLAYER_MISMATCH,
    );
  });
  it('CURRENCY_MISMATCH for another currency', () => {
    expect(checkWalletOwnership({ playerId: PLAYER, currency: 'USD' }, wallet('1.00'))).toBe(FailureCode.CURRENCY_MISMATCH);
  });
});

describe('WagerTransaction.create', () => {
  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])('%s without reference is a domain error', (kind) => {
    expect(() =>
      WagerTransaction.create({
        id: generateId(),
        providerId: 'p',
        externalTransactionId: 'e',
        idempotencyKey: 'k',
        payloadHash: 'h',
        walletId: WALLET,
        playerId: PLAYER,
        roundId: 'r',
        gameId: 'g',
        kind,
        money: Money.from({ amount: '1.00', currency: 'BRL' }),
        createdAt: at,
      }),
    ).toThrow(MissingReferenceError);
  });
});

describe('balance limit (NUMERIC(19,2) capacity)', () => {
  it('a credit that would exceed the storable maximum is not applied: BALANCE_LIMIT_EXCEEDED', () => {
    const w = wallet('99999999999999999.00');
    const result = settle(tx({ kind: WagerTransactionKind.Win, amount: '1.00' }), w, null, at);
    expect(result).toEqual({ applied: false, failureCode: FailureCode.BALANCE_LIMIT_EXCEEDED });
    expect(w.balance.amount).toBe('99999999999999999.00');
  });

  it('a credit up to exactly the maximum is applied, with exact decimal arithmetic', () => {
    const w = wallet('99999999999999998.98');
    const result = settle(tx({ kind: WagerTransactionKind.Win, amount: '1.01' }), w, null, at);
    expect(result.applied).toBe(true);
    expect(w.balance.amount).toBe('99999999999999999.99');
  });
});

describe('checkWinReference (optional WIN -> BET link)', () => {
  const win = (o: TxOverrides = {}) => tx({ kind: WagerTransactionKind.Win, status: WagerTransactionStatus.Pending, ...o });

  it('accepts a PROCESSED BET of the same context, whatever the amount', () => {
    expect(checkWinReference(win({ amount: '500.00' }), tx({ kind: WagerTransactionKind.Bet, amount: '10.00' }))).toBeNull();
  });

  it.each([
    ['round', { roundId: 'round-2' }, FailureCode.CROSS_ROUND_REFERENCE],
    ['player', { playerId: 'player-2' }, FailureCode.CROSS_PLAYER_REFERENCE],
    ['wallet', { walletId: 'wallet-2' }, FailureCode.CROSS_WALLET_REFERENCE],
    ['currency', { currency: 'USD' }, FailureCode.CURRENCY_MISMATCH],
  ] as const)('rejects a BET from another %s', (_label, refOverrides, code) => {
    expect(checkWinReference(win(), tx({ kind: WagerTransactionKind.Bet, ...refOverrides }))).toBe(code);
  });

  it('rejects a reference that is not a BET, or a BET that was not processed', () => {
    expect(checkWinReference(win(), tx({ kind: WagerTransactionKind.Loss }))).toBe(FailureCode.INVALID_REFERENCE_KIND);
    expect(checkWinReference(win(), tx({ kind: WagerTransactionKind.Bet, status: WagerTransactionStatus.Rejected }))).toBe(
      FailureCode.REFERENCE_NOT_PROCESSED,
    );
  });
});
