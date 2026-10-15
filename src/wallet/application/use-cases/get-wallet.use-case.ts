import { Inject, Injectable } from '@nestjs/common';
import { WALLET_REPOSITORY } from '../../domain/wallet.repository.port';
import type { WalletRepositoryPort } from '../../domain/wallet.repository.port';
import { WalletDto } from './open-wallet.use-case';
import { notFound } from '../../../shared/application/request-validation';

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepositoryPort) {}

  async execute(walletId: string): Promise<WalletDto> {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) {
      throw notFound('WALLET_NOT_FOUND', `Wallet not found: ${walletId}`);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
