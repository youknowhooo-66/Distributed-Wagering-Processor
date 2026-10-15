import { Inject, Injectable, NotFoundException, Logger, Optional } from '@nestjs/common';
import { WALLET_REPOSITORY } from '../../domain/wallet.repository.port';
import type { WalletRepositoryPort } from '../../domain/wallet.repository.port';
import { Money, MoneyProps } from '../../../shared/domain/value-objects';
import {
  NoopWageringMetrics,
  WageringMetrics,
} from '../../../shared/application/ports/wagering-metrics.port';

export interface ReconciliationResultDto {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  /** Balance equals the ledger sum AND every ledger entry matches its transaction. */
  consistent: boolean;
  checkedEntries: number;
  /** Ledger entries / processed transactions that disagree with each other (see repository). */
  transactionMismatches: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepositoryPort,
    @Optional() private readonly metrics: WageringMetrics = new NoopWageringMetrics(),
  ) {}

  async execute(walletId: string): Promise<ReconciliationResultDto> {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet not found: ${walletId}`);
    }

    const calculatedBalanceStr = await this.walletRepo.sumLedgerBalance(walletId);
    const checkedEntries = await this.walletRepo.countLedgerEntries(walletId);
    const transactionMismatches = await this.walletRepo.countLedgerTransactionMismatches(walletId);

    const storedMoney = wallet.balance;
    const calculatedMoney = Money.fromInternal(calculatedBalanceStr, wallet.currency);
    const diffMoney = storedMoney.subtract(calculatedMoney);

    const isConsistent = diffMoney.isZero() && transactionMismatches === 0;

    if (!isConsistent) {
      this.metrics.reconciliationDiscrepancy();
      // Never corrected automatically: logged, counted and returned for investigation
      this.logger.error({
        msg: 'RECONCILIATION_DISCREPANCY: stored balance and ledger disagree',
        walletId,
        correlationId: walletId,
        currency: storedMoney.currency,
        checkedEntries,
        difference: diffMoney.amount,
        transactionMismatches,
      });
    } else {
      this.logger.log({ msg: 'RECONCILIATION_OK', walletId, correlationId: walletId, checkedEntries });
    }

    return {
      walletId: wallet.id,
      storedBalance: storedMoney.toJSON(),
      calculatedBalance: calculatedMoney.toJSON(),
      difference: diffMoney.toJSON(),
      consistent: isConsistent,
      checkedEntries,
      transactionMismatches,
    };
  }
}
