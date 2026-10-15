import { BadRequestException, NotFoundException } from '@nestjs/common';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 404 with a machine-readable code (WALLET_NOT_FOUND, TRANSACTION_NOT_FOUND). */
export function notFound(code: 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND', message: string): NotFoundException {
  return new NotFoundException({ statusCode: 404, error: code, message });
}

/** 400 INVALID_PAYLOAD with the list of violations (same shape for every endpoint). */
export function invalidPayload(violations: string[]): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'INVALID_PAYLOAD', message: violations });
}

/**
 * Path identifiers are UUID columns: a malformed one is a client error (400), not a lookup
 * that PostgreSQL would reject with a cast error (500). Returns the id lowercased.
 */
export function parseUuidParam(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new BadRequestException({ statusCode: 400, error: 'INVALID_ID', message: `${name} must be a UUID` });
  }
  return value.toLowerCase();
}
