import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { Money, MoneyProps } from '../../../shared/domain/value-objects';
import { Wallet } from '../../domain/wallet.entity';
import {
  type TransactionScope,
  UnitOfWork,
  UniqueViolationError,
} from '../../../shared/application/ports/unit-of-work.port';
import { UUID_PATTERN, invalidPayload } from '../../../shared/application/request-validation';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../wagering/domain/wager-transaction.entity';
import { WalletBalanceChanged } from '../../../wagering/domain/events/wallet-balance-changed.event';
import { WagerTransactionProcessed } from '../../../wagering/domain/events/wager-transaction-processed.event';
import { OutboxMessage } from '../../../wagering/domain/outbox-message.entity';
import { generateId } from '../../../shared/domain/identifier';
import { computePayloadHash } from '../../../shared/domain/canonical-hash';
import { RESERVED_PROVIDER_ID } from '../../../wagering/application/wager-payload.validator';

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

const UQ_WALLET_PLAYER_CURRENCY = 'uq_wallets_player_currency';

/** Contract of POST /wallets (money format itself is validated by Money.from -> 400). */
export function validateOpenWalletCommand(input: unknown): string[] {
  if (!input || typeof input !== 'object') return ['payload must be an object'];
  const data = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof data.playerId !== 'string' || !UUID_PATTERN.test(data.playerId)) {
    errors.push('playerId must be a UUID');
  }
  const balance = data.initialBalance as Record<string, unknown> | undefined;
  if (!balance || typeof balance !== 'object') {
    errors.push('initialBalance must be an object with amount and currency');
  } else {
    if (typeof balance.amount !== 'string' || !/^\d{1,17}\.\d{2}$/.test(balance.amount)) {
      errors.push('initialBalance.amount must be a non-negative decimal string with 2 decimal places, e.g. "100.00"');
    }
    if (typeof balance.currency !== 'string' || !/^[A-Z]{3}$/.test(balance.currency)) {
      errors.push('initialBalance.currency must be an ISO-4217 code, e.g. "BRL"');
    }
  }
  return errors;
}

@Injectable()
export class OpenWalletUseCase {
  private readonly logger = new Logger(OpenWalletUseCase.name);

  constructor(private readonly uow: UnitOfWork) {}

  async execute(input: OpenWalletCommand): Promise<WalletDto> {
    const violations = validateOpenWalletCommand(input);
    if (violations.length > 0) throw invalidPayload(violations);

    const cmd = { ...input, playerId: input.playerId.toLowerCase() };
    const initialMoney = Money.from(cmd.initialBalance);

    try {
      const dto = await this.uow.transactional((scope) => this.open(scope, cmd, initialMoney));
      this.logger.log({ msg: 'wallet opened', walletId: dto.id, correlationId: dto.id });
      return dto;
    } catch (err) {
      // Two concurrent requests for the same (playerId, currency): the loser is a conflict too
      if (err instanceof UniqueViolationError && err.constraint === UQ_WALLET_PLAYER_CURRENCY) {
        throw this.conflict(cmd.playerId, initialMoney.currency);
      }
      throw err;
    }
  }

  private async open(
    scope: TransactionScope,
    cmd: OpenWalletCommand,
    initialMoney: Money,
  ): Promise<WalletDto> {
    const { wallets: walletRepo, wagers: wagerRepo } = scope;

    const existing = await walletRepo.findByPlayerIdAndCurrency(cmd.playerId, initialMoney.currency);
    if (existing) {
      throw this.conflict(cmd.playerId, initialMoney.currency);
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
    await scope.flush(); // wallet row first: ledger and transaction reference it

    if (initialMoney.isPositive()) {
      // Internal OPENING transaction + CREDIT entry, in this same SQL transaction
      const txId = generateId();
      const openingTx = WagerTransaction.create({
        id: txId,
        providerId: RESERVED_PROVIDER_ID,
        externalTransactionId: `opening-${walletId}`,
        idempotencyKey: `internal:opening:${walletId}`,
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

      const ledgerEntry = wallet.openingEntry(txId);
      await walletRepo.saveLedgerEntry(ledgerEntry);
      await wagerRepo.save(openingTx);

      // OPENING is an applied transaction too: same pair of events as any balance-moving one
      const ctx = { correlationId: txId };
      await wagerRepo.saveOutboxMessage(OutboxMessage.enqueue(WagerTransactionProcessed.from(openingTx, ctx)));
      await wagerRepo.saveOutboxMessage(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, ctx)));
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  private conflict(playerId: string, currency: string): ConflictException {
    return new ConflictException({
      statusCode: 409,
      error: 'WALLET_ALREADY_EXISTS',
      message: `Wallet already exists for playerId ${playerId} with currency ${currency}`,
    });
  }
}
