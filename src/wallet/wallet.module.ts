import { Module, forwardRef } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WalletMikroEntity } from './infrastructure/persistence/wallet.mikro-entity';
import { WalletLedgerEntryMikroEntity } from './infrastructure/persistence/wallet-ledger-entry.mikro-entity';
import { WalletRepository } from './infrastructure/persistence/wallet.repository';
import { WALLET_REPOSITORY } from './domain/wallet.repository.port';
import { OpenWalletUseCase } from './application/use-cases/open-wallet.use-case';
import { GetWalletUseCase } from './application/use-cases/get-wallet.use-case';
import { GetWalletLedgerUseCase } from './application/use-cases/get-wallet-ledger.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { WalletController } from './infrastructure/http/wallet.controller';
import { WageringModule } from '../wagering/wagering.module';

@Module({
  imports: [
    MikroOrmModule.forFeature([WalletMikroEntity, WalletLedgerEntryMikroEntity]),
    forwardRef(() => WageringModule),
  ],
  controllers: [WalletController],
  providers: [
    WalletRepository,
    { provide: WALLET_REPOSITORY, useExisting: WalletRepository },
    OpenWalletUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    ReconcileWalletUseCase,
  ],
  exports: [WalletRepository, WALLET_REPOSITORY],
})
export class WalletModule {}
