import { Injectable, ConflictException } from '@nestjs/common';
import { Money, MoneyProps } from '../../../shared/domain/value-objects';
import { Wallet } from '../../domain/wallet.entity';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/wallet-ledger-entry.entity';
import { UnitOfWork } from '../../../shared/application/ports/unit-of-work.port';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../wagering/domain/wager-transaction.entity';
import { WalletBalanceChanged } from '../../../wagering/domain/events/wallet-balance-changed.event';
import { OutboxMessage } from '../../../wagering/domain/outbox-message.entity';
import { generateId } from '../../../shared/domain/identifier';
import { computePayloadHash } from '../../../shared/domain/canonical-hash';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletDto {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class OpenWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(cmd: OpenWalletCommand): Promise<WalletDto> {
    const initialMoney = Money.from(cmd.initialBalance);

    return this.uow.transactional(async (scope) => {
      const { wallets: walletRepo, wagers: wagerRepo } = scope;

      // Check if wallet already exists for (playerId, currency)
      const existing = await walletRepo.findByPlayerIdAndCurrency(
        cmd.playerId,
        initialMoney.currency,
      );
      if (existing) {
        throw new ConflictException(
          `Wallet already exists for playerId ${cmd.playerId} with currency ${initialMoney.currency}`,
        );
      }

      const walletId = generateId();
      const now = new Date();
      const wallet = Wallet.open({
        id: walletId,
        playerId: cmd.playerId,
        currency: initialMoney.currency,
        createdAt: now,
        initialBalance: initialMoney,
      });

      await walletRepo.save(wallet);
      await scope.flush(); // Ensure wallet row is inserted first for foreign keys

      if (!initialMoney.isZero()) {
        const txId = generateId();
        const idempotencyKey = `internal:opening:${walletId}`;
        const openingTx = WagerTransaction.create({
          id: txId,
          providerId: 'system',
          externalTransactionId: `opening-${walletId}`,
          idempotencyKey,
          payloadHash: computePayloadHash({ walletId, initialBalance: cmd.initialBalance }),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'system-opening',
          gameId: 'system',
          kind: WagerTransactionKind.Opening,
          money: initialMoney,
          createdAt: now,
        });

        openingTx.markProcessed(undefined, now, initialMoney);

        const ledgerEntry = WalletLedgerEntry.create({
          id: generateId(),
          walletId: wallet.id,
          transactionId: txId,
          direction: LedgerDirection.Credit,
          money: initialMoney,
          balanceBefore: Money.zero(initialMoney.currency),
          balanceAfter: initialMoney,
          createdAt: now,
        });

        await walletRepo.save(wallet);
        await walletRepo.saveLedgerEntry(ledgerEntry);
        await wagerRepo.save(openingTx);

        // Integration event
        const balanceEvent = WalletBalanceChanged.from(wallet, ledgerEntry, {
          correlationId: txId,
        });
        await wagerRepo.saveOutboxMessage(OutboxMessage.enqueue(balanceEvent));
      } else {
        await walletRepo.save(wallet);
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
