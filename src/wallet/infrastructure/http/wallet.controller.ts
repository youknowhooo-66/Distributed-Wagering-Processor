import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { OpenWalletUseCase } from '../../application/use-cases/open-wallet.use-case';
import { GetWalletUseCase } from '../../application/use-cases/get-wallet.use-case';
import {
  GetWalletLedgerUseCase,
  parseLedgerLimit,
} from '../../application/use-cases/get-wallet-ledger.use-case';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';
import { NoopAuthGuard } from '../../../shared/application/ports/auth.guard';
import { parseUuidParam } from '../../../shared/application/request-validation';
import { MoneyProps } from '../../../shared/domain/value-objects';

export interface CreateWalletBody {
  playerId: string;
  initialBalance: MoneyProps;
}

@Controller('wallets')
@UseGuards(NoopAuthGuard)
export class WalletController {
  constructor(
    private readonly openWalletUseCase: OpenWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(@Body() body: CreateWalletBody) {
    return this.openWalletUseCase.execute(body);
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string) {
    return this.getWalletUseCase.execute(parseUuidParam(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.getWalletLedgerUseCase.execute(
      parseUuidParam(walletId, 'walletId'),
      parseLedgerLimit(limit),
      cursor || undefined,
    );
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string) {
    return this.reconcileWalletUseCase.execute(parseUuidParam(walletId, 'walletId'));
  }
}
