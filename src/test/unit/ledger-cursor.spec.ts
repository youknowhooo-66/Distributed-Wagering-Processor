import { describe, it, expect } from 'bun:test';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  parseLedgerLimit,
  MAX_LEDGER_LIMIT,
} from '../../wallet/application/use-cases/get-wallet-ledger.use-case';
import { validateOpenWalletCommand } from '../../wallet/application/use-cases/open-wallet.use-case';

describe('ledger cursor and limit', () => {
  it('round-trips an opaque cursor', () => {
    const cursor = encodeLedgerCursor(42);
    expect(cursor).not.toContain('42');
    expect(decodeLedgerCursor(cursor)).toBe(42);
  });

  it.each(['', 'garbage', Buffer.from('v1:0').toString('base64url'), Buffer.from('v2:5').toString('base64url'), Buffer.from('v1:-3').toString('base64url')])(
    'rejects an invalid cursor %p with 400',
    (cursor) => {
      expect(() => decodeLedgerCursor(cursor)).toThrow('cursor is not valid');
    },
  );

  it('limit defaults to 50 and accepts 1..max', () => {
    expect(parseLedgerLimit(undefined)).toBe(50);
    expect(parseLedgerLimit('1')).toBe(1);
    expect(parseLedgerLimit(String(MAX_LEDGER_LIMIT))).toBe(MAX_LEDGER_LIMIT);
  });

  it.each(['0', '-1', '1.5', 'abc', String(MAX_LEDGER_LIMIT + 1)])('rejects limit=%p', (raw) => {
    expect(() => parseLedgerLimit(raw)).toThrow('limit must be an integer');
  });
});

describe('POST /wallets contract', () => {
  it('accepts a valid command', () => {
    expect(
      validateOpenWalletCommand({
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        initialBalance: { amount: '0.00', currency: 'BRL' },
      }),
    ).toEqual([]);
  });

  it('lists every violation', () => {
    expect(validateOpenWalletCommand({ playerId: 'x', initialBalance: { amount: 10, currency: 'brl' } })).toHaveLength(3);
    expect(validateOpenWalletCommand(undefined)).toEqual(['payload must be an object']);
  });
});
