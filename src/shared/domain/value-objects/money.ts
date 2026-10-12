import Decimal from 'decimal.js';
import { InvalidMoneyError, CurrencyMismatchError } from '../errors';

/**
 * DTO interface for serialization/deserialization of Money.
 * Used in API contracts and event payloads.
 */
export interface MoneyProps {
  /** Decimal string with exactly 2 decimal places, e.g. "25.00" */
  amount: string;
  /** ISO-4217 currency code, e.g. "BRL" */
  currency: string;
}

// Regex: optional sign (internal), digits, mandatory dot, exactly 2 decimal digits
const VALID_DECIMAL_PATTERN = /^-?\d+\.\d{2}$/;
const VALID_CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable Value Object representing a monetary amount with exact precision.
 *
 * Invariants:
 * - amount is always stored as a Decimal with exactly 2 decimal places
 * - all arithmetic operations return new Money instances
 * - operations between different currencies throw CurrencyMismatchError
 * - factory `from()` rejects NaN, Infinity, scientific notation, empty strings,
 *   more than 2 decimal places, and negative values
 * - internal factory `fromInternal()` allows negative values for intermediate calculations
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Creates Money from external input (API/message contracts).
   * Rejects negative values — use fromInternal for domain-level negation.
   */
  static from(props: MoneyProps): Money {
    Money.validateCurrency(props.currency);
    const value = Money.parseAmount(props.amount);

    if (value.isNegative()) {
      throw new InvalidMoneyError('amount must not be negative in input contracts');
    }

    return new Money(value, props.currency);
  }

  /**
   * Creates Money allowing negative values.
   * Used internally when reconstructing from persistence or intermediate calculations.
   */
  static fromInternal(amount: string, currency: string): Money {
    Money.validateCurrency(currency);
    const value = Money.parseAmount(amount);
    return new Money(value, currency);
  }

  /**
   * Creates a zero-value Money for the given currency.
   */
  static zero(currency: string): Money {
    Money.validateCurrency(currency);
    return new Money(new Decimal('0.00'), currency);
  }

  // ── Arithmetic (always returns new instance) ──

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  // ── Comparison ──

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.value.equals(other.value) && this.currency === other.currency;
  }

  // ── Serialization ──

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  /**
   * Returns the raw decimal string with 2 decimal places.
   * Used for persistence mapping.
   */
  get amount(): string {
    return this.value.toFixed(2);
  }

  // ── Private helpers ──

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static validateCurrency(currency: string): void {
    if (!currency || !VALID_CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        `invalid ISO-4217 currency code: "${currency}"`,
      );
    }
  }

  private static parseAmount(raw: string): Decimal {
    if (raw === undefined || raw === null || raw === '') {
      throw new InvalidMoneyError('amount must not be empty');
    }

    // Reject scientific notation (e.g., "1e2", "2.5E-3")
    if (/[eE]/.test(raw)) {
      throw new InvalidMoneyError(
        `scientific notation is not allowed: "${raw}"`,
      );
    }

    // Reject values that don't match strict decimal format
    if (!VALID_DECIMAL_PATTERN.test(raw)) {
      throw new InvalidMoneyError(
        `amount must be a decimal string with exactly 2 decimal places: "${raw}"`,
      );
    }

    let value: Decimal;
    try {
      value = new Decimal(raw);
    } catch {
      throw new InvalidMoneyError(`cannot parse amount: "${raw}"`);
    }

    if (!value.isFinite()) {
      throw new InvalidMoneyError(`amount must be finite: "${raw}"`);
    }

    return value;
  }
}
