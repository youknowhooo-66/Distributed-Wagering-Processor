import { describe, it, expect } from 'bun:test';
import { Money } from '../../shared/domain/value-objects';
import { InvalidMoneyError, CurrencyMismatchError } from '../../shared/domain/errors';

describe('Money Value Object', () => {
  describe('creation and validation', () => {
    it('creates Money with valid decimal string and currency', () => {
      const money = Money.from({ amount: '25.00', currency: 'BRL' });
      expect(money.amount).toBe('25.00');
      expect(money.currency).toBe('BRL');
      expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(money.toString()).toBe('25.00 BRL');
    });

    it('creates zero Money', () => {
      const zero = Money.zero('BRL');
      expect(zero.amount).toBe('0.00');
      expect(zero.isZero()).toBe(true);
    });

    it('rejects negative amount in from() contract', () => {
      expect(() => Money.from({ amount: '-25.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it('rejects more than 2 decimal places', () => {
      expect(() => Money.from({ amount: '25.001', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '25.1', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '25', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it('rejects scientific notation', () => {
      expect(() => Money.from({ amount: '1e2.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '2.5E-3', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it('rejects empty string and invalid strings', () => {
      expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: 'abc', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: 'Infinity', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it('rejects invalid currency codes', () => {
      expect(() => Money.from({ amount: '10.00', currency: 'brl' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '10.00', currency: 'BR' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '10.00', currency: 'BRLX' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '10.00', currency: '' })).toThrow(InvalidMoneyError);
    });

    it('allows negative amounts in fromInternal()', () => {
      const negative = Money.fromInternal('-10.00', 'BRL');
      expect(negative.amount).toBe('-10.00');
      expect(negative.isNegative()).toBe(true);
    });
  });

  describe('arithmetic operations', () => {
    it('adds two Money instances with exact precision', () => {
      const a = Money.from({ amount: '10.50', currency: 'BRL' });
      const b = Money.from({ amount: '5.25', currency: 'BRL' });
      const sum = a.add(b);

      expect(sum.amount).toBe('15.75');
      // Immutability: original instances unchanged
      expect(a.amount).toBe('10.50');
      expect(b.amount).toBe('5.25');
    });

    it('subtracts two Money instances', () => {
      const a = Money.from({ amount: '100.00', currency: 'BRL' });
      const b = Money.from({ amount: '35.50', currency: 'BRL' });
      const diff = a.subtract(b);

      expect(diff.amount).toBe('64.50');
    });

    it('negates a Money instance', () => {
      const a = Money.from({ amount: '10.00', currency: 'BRL' });
      const negated = a.negate();
      expect(negated.amount).toBe('-10.00');
      expect(negated.isNegative()).toBe(true);
    });

    it('throws CurrencyMismatchError when adding or subtracting different currencies', () => {
      const brl = Money.from({ amount: '10.00', currency: 'BRL' });
      const usd = Money.from({ amount: '10.00', currency: 'USD' });

      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe('comparisons', () => {
    it('correctly compares equality', () => {
      const a = Money.from({ amount: '25.00', currency: 'BRL' });
      const b = Money.from({ amount: '25.00', currency: 'BRL' });
      const c = Money.from({ amount: '25.00', currency: 'USD' });
      const d = Money.from({ amount: '26.00', currency: 'BRL' });

      expect(a.equals(b)).toBe(true);
      expect(a.equals(c)).toBe(false);
      expect(a.equals(d)).toBe(false);
    });

    it('correctly compares isLessThan', () => {
      const a = Money.from({ amount: '10.00', currency: 'BRL' });
      const b = Money.from({ amount: '20.00', currency: 'BRL' });

      expect(a.isLessThan(b)).toBe(true);
      expect(b.isLessThan(a)).toBe(false);
    });

    it('correctly detects isZero, isPositive, isNegative', () => {
      const zero = Money.zero('BRL');
      const pos = Money.from({ amount: '0.01', currency: 'BRL' });
      const neg = Money.fromInternal('-0.01', 'BRL');

      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);

      expect(pos.isPositive()).toBe(true);
      expect(pos.isZero()).toBe(false);
      expect(pos.isNegative()).toBe(false);

      expect(neg.isNegative()).toBe(true);
      expect(neg.isPositive()).toBe(false);
      expect(neg.isZero()).toBe(false);
    });
  });
});
