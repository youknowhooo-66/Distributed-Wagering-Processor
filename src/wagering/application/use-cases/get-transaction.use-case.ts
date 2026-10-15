import { Inject, Injectable } from '@nestjs/common';
import { WAGER_TRANSACTION_REPOSITORY } from '../../domain/wager-transaction.repository.port';
import type { WagerTransactionRepositoryPort } from '../../domain/wager-transaction.repository.port';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction.entity';
import { MoneyProps } from '../../../shared/domain/value-objects';
import { notFound } from '../../../shared/application/request-validation';

export interface TransactionDto {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  createdAt: string;
  processedAt?: string;
}

@Injectable()
export class GetTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagerRepo: WagerTransactionRepositoryPort,
  ) {}

  async executeById(id: string): Promise<TransactionDto> {
    const tx = await this.wagerRepo.findById(id);
    if (!tx) {
      throw notFound('TRANSACTION_NOT_FOUND', `Transaction not found: ${id}`);
    }
    return this.toDto(tx);
  }

  async executeByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionDto> {
    const tx = await this.wagerRepo.findByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!tx) {
      throw notFound(
        'TRANSACTION_NOT_FOUND',
        `Transaction not found for provider ${providerId} and external ID ${externalTransactionId}`,
      );
    }
    return this.toDto(tx);
  }

  private toDto(tx: WagerTransaction): TransactionDto {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt?.toISOString(),
    };
  }
}
