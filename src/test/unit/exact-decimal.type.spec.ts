import { describe, it, expect } from 'bun:test';
import { DecimalType } from '@mikro-orm/core';
import { ExactDecimalType } from '../../shared/infrastructure/database/exact-decimal.type';

/**
 * MikroORM's DecimalType compares amounts as JS numbers, so two different large balances look
 * equal and the UPDATE is skipped. The money columns use ExactDecimalType instead.
 */
describe('ExactDecimalType (money columns)', () => {
  const big1 = '99999999999999994.00';
  const big2 = '99999999999999999.00';

  it('documents the float comparison of the stock DecimalType (the bug being avoided)', () => {
    const stock = new DecimalType('string');
    (stock as any).prop = { scale: 2 };
    expect(stock.compareValues(big1, big2)).toBe(true); // wrong: treated as "unchanged"
  });

  it('compares exactly at the column scale', () => {
    const exact = new ExactDecimalType();
    expect(exact.compareValues(big1, big2)).toBe(false);
    expect(exact.compareValues('90000000000000.01', '90000000000000.02')).toBe(false);
    expect(exact.compareValues('10.5', '10.50')).toBe(true);
    expect(exact.compareValues(null, null)).toBe(true);
    expect(exact.compareValues(null, '0.00')).toBe(false);
  });

  it('hydrates as a decimal string with 2 places, never a number', () => {
    const exact = new ExactDecimalType();
    expect(exact.convertToJSValue('99999999999999999.99')).toBe('99999999999999999.99');
    expect(exact.convertToJSValue('7')).toBe('7.00');
    expect(exact.compareAsType()).toBe('string');
  });
});
