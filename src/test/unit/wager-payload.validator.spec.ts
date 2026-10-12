import { describe, it, expect } from 'bun:test';
import { validateWagerPayload } from '../../wagering/application/wager-payload.validator';

const valid = {
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('validateWagerPayload', () => {
  it('accepts a valid BET', () => {
    expect(validateWagerPayload(valid)).toEqual([]);
  });

  it('accepts LOSS with zero amount and WIN with an informational reference', () => {
    expect(validateWagerPayload({ ...valid, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } })).toEqual([]);
    expect(validateWagerPayload({ ...valid, kind: 'WIN', referenceExternalTransactionId: 'tx-0' })).toEqual([]);
  });

  it.each([
    ['zero BET amount', { money: { amount: '0.00', currency: 'BRL' } }, 'greater than zero'],
    ['3 decimal places', { money: { amount: '1.005', currency: 'BRL' } }, 'money.amount'],
    ['numeric amount', { money: { amount: 25, currency: 'BRL' } }, 'money.amount'],
    ['scientific notation', { money: { amount: '1e3', currency: 'BRL' } }, 'money.amount'],
    ['negative amount', { money: { amount: '-1.00', currency: 'BRL' } }, 'money.amount'],
    ['amount beyond NUMERIC(19,2)', { money: { amount: '123456789012345678.00', currency: 'BRL' } }, 'money.amount'],
    ['lowercase currency', { money: { amount: '1.00', currency: 'brl' } }, 'money.currency'],
    ['unknown kind', { kind: 'BONUS' }, 'kind'],
    ['internal OPENING kind', { kind: 'OPENING' }, 'kind'],
    ['non-UUID walletId', { walletId: 'wallet-1' }, 'walletId'],
    ['non-UUID playerId', { playerId: 'player-1' }, 'playerId'],
    ['missing roundId', { roundId: undefined }, 'roundId'],
    ['blank gameId', { gameId: '   ' }, 'gameId'],
    ['providerId over 100 chars', { providerId: 'p'.repeat(101) }, 'providerId'],
    ['REFUND without reference', { kind: 'REFUND' }, 'referenceExternalTransactionId'],
    ['ROLLBACK with blank reference', { kind: 'ROLLBACK', referenceExternalTransactionId: '' }, 'referenceExternalTransactionId'],
  ])('rejects %s', (_label, override, field) => {
    const errors = validateWagerPayload({ ...valid, ...override });
    expect(errors.some((e) => e.includes(field as string))).toBe(true);
  });

  it('rejects non-object payloads', () => {
    expect(validateWagerPayload(null)).toEqual(['payload must be an object']);
    expect(validateWagerPayload('BET')).toEqual(['payload must be an object']);
  });
});
