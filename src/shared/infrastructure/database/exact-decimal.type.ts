import Decimal from 'decimal.js';
import { DecimalType } from '@mikro-orm/core';

/**
 * NUMERIC(19,2) mapped to a decimal string, compared **exactly**.
 *
 * MikroORM's built-in DecimalType decides whether a value changed by converting both sides to
 * a JS number (`+value`). Above ~9e13 two different amounts become the same float (e.g.
 * "99999999999999994.00" and "99999999999999999.00"), the change is considered a no-op and the
 * UPDATE is silently skipped — a lost balance update. Money never goes through a float here:
 * values are normalized with decimal.js to the column scale and compared as strings.
 */
export class ExactDecimalType extends DecimalType {
  constructor() {
    super('string');
  }

  override convertToJSValue(value: unknown): string {
    return ExactDecimalType.normalize(value);
  }

  override compareValues(a: unknown, b: unknown): boolean {
    if (a === null || a === undefined || b === null || b === undefined) return a === b;
    return ExactDecimalType.normalize(a) === ExactDecimalType.normalize(b);
  }

  override compareAsType(): string {
    return 'string';
  }

  private static normalize(value: unknown): string {
    return new Decimal(String(value)).toFixed(2);
  }
}
