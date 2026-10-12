import { describe, it, expect } from 'bun:test';
import { canonicalizeJson, computePayloadHash } from '../../shared/domain/canonical-hash';

describe('Canonical JSON and Payload Hash', () => {
  it('produces identical canonical string regardless of key ordering', () => {
    const objA = {
      roundId: 'r-1',
      gameId: 'fortune-chimp',
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
    };

    const objB = {
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      roundId: 'r-1',
      gameId: 'fortune-chimp',
    };

    expect(canonicalizeJson(objA)).toBe(canonicalizeJson(objB));
    expect(computePayloadHash(objA)).toBe(computePayloadHash(objB));
  });

  it('produces different hash for different payload values', () => {
    const objA = {
      roundId: 'r-1',
      gameId: 'fortune-chimp',
      money: { amount: '25.00', currency: 'BRL' },
    };

    const objB = {
      roundId: 'r-1',
      gameId: 'fortune-chimp',
      money: { amount: '25.01', currency: 'BRL' },
    };

    expect(computePayloadHash(objA)).not.toBe(computePayloadHash(objB));
  });
});
