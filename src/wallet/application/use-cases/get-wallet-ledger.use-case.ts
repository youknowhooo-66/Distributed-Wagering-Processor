import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { WALLET_REPOSITORY } from '../../domain/wallet.repository.port';
import type { WalletRepositoryPort } from '../../domain/wallet.repository.port';
import { MoneyProps } from '../../../shared/domain/value-objects';
import { LedgerDirection } from '../../domain/wallet-ledger-entry.entity';

export interface LedgerEntryDto {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPaginationResult {
  entries: LedgerEntryDto[];
  nextCursor: string | null;
}

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(@Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepositoryPort) {}

  async execute(
    walletId: string,
    limit: number = 50,
    cursor?: string,
  ): Promise<LedgerPaginationResult> {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet not found: ${walletId}`);
    }

    let parsedCursor: { createdAt: Date; id: string } | undefined;
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
        const [dateStr, id] = decoded.split('|');
        if (dateStr && id) {
          parsedCursor = { createdAt: new Date(dateStr), id };
        }
      } catch {
        // invalid cursor falls back to undefined
      }
    }

    // Fetch limit + 1 to determine if next page exists
    const entries = await this.walletRepo.findLedgerEntries(
      walletId,
      limit + 1,
      parsedCursor,
    );

    const hasMore = entries.length > limit;
    const pagedEntries = hasMore ? entries.slice(0, limit) : entries;

    let nextCursor: string | null = null;
    if (hasMore && pagedEntries.length > 0) {
      const last = pagedEntries[pagedEntries.length - 1];
      if (last) {
        const rawCursor = `${last.createdAt.toISOString()}|${last.id}`;
        nextCursor = Buffer.from(rawCursor, 'utf-8').toString('base64');
      }
    }

    return {
      entries: pagedEntries.map((e) => ({
        id: e.id,
        walletId: e.walletId,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }
}
