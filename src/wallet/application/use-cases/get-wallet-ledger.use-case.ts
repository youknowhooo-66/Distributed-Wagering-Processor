import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { WALLET_REPOSITORY } from '../../domain/wallet.repository.port';
import type { WalletRepositoryPort } from '../../domain/wallet.repository.port';
import { MoneyProps } from '../../../shared/domain/value-objects';
import { LedgerDirection } from '../../domain/wallet-ledger-entry.entity';
import { notFound } from '../../../shared/application/request-validation';

export interface LedgerEntryDto {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPaginationResult {
  entries: LedgerEntryDto[];
  nextCursor: string | null;
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

/**
 * Opaque cursor: base64url("v1:<walletVersion>") of the last entry returned. walletVersion is
 * unique and gap-free per wallet, so pages never skip or repeat entries, even while new
 * movements are being appended (they only appear on the first page).
 */
const CURSOR_PREFIX = 'v1:';

export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${walletVersion}`, 'utf-8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
  const match = /^v1:(\d{1,10})$/.exec(decoded);
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new BadRequestException({ statusCode: 400, error: 'INVALID_CURSOR', message: 'cursor is not valid' });
  }
  return version;
}

/** Parses the `limit` query parameter: integer between 1 and MAX_LEDGER_LIMIT. */
export function parseLedgerLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LEDGER_LIMIT;
  const limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'INVALID_LIMIT',
      message: `limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`,
    });
  }
  return limit;
}

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(@Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepositoryPort) {}

  async execute(
    walletId: string,
    limit: number = DEFAULT_LEDGER_LIMIT,
    cursor?: string,
  ): Promise<LedgerPaginationResult> {
    const beforeVersion = cursor ? decodeLedgerCursor(cursor) : undefined;

    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) {
      throw notFound('WALLET_NOT_FOUND', `Wallet not found: ${walletId}`);
    }

    // Fetch limit + 1 to determine if next page exists
    const entries = await this.walletRepo.findLedgerEntries(walletId, limit + 1, beforeVersion);

    const hasMore = entries.length > limit;
    const pagedEntries = hasMore ? entries.slice(0, limit) : entries;
    const last = pagedEntries[pagedEntries.length - 1];

    return {
      entries: pagedEntries.map((e) => ({
        id: e.id,
        walletId: e.walletId,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        walletVersion: e.walletVersion,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: hasMore && last ? encodeLedgerCursor(last.walletVersion) : null,
    };
  }
}
