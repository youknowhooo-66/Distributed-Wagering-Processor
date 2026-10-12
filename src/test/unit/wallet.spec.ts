import { describe, it, expect } from 'bun:test';
import { Wallet } from '../../wallet/domain/wallet.entity';
import { LedgerDirection, WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.entity';
import { Money } from '../../shared/domain/value-objects';
import { InsufficientBalanceError, CurrencyMismatchError, InvalidLedgerEntryError } from '../../shared/domain/errors';

describe('Wallet and WalletLedgerEntry', () => {
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
  const now = new Date('2026-07-29T15:00:00.000Z');

  describe('Wallet Aggregate Root', () => {
    it('opens a wallet with zero balance and version 1', () => {
      const wallet = Wallet.open({
        id: walletId,
        playerId,
        currency: 'BRL',
        createdAt: now,
      });

      expect(wallet.id).toBe(walletId);
      expect(wallet.playerId).toBe(playerId);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.amount).toBe('0.00');
      expect(wallet.version).toBe(1);
    });

    it('credits balance, increments version, and produces balanced ledger entry', () => {
      const wallet = Wallet.open({ id: walletId, playerId, currency: 'BRL', createdAt: now });
      const deposit = Money.from({ amount: '100.00', currency: 'BRL' });
      const txId = 'tx-1';

      const entry = wallet.credit(txId, deposit, now);

      expect(wallet.balance.amount).toBe('100.00');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.money.amount).toBe('100.00');
      expect(entry.balanceBefore.amount).toBe('0.00');
      expect(entry.balanceAfter.amount).toBe('100.00');
      expect(entry.isBalanced()).toBe(true);
    });

    it('debits balance, increments version, and produces balanced ledger entry', () => {
      const wallet = Wallet.open({ id: walletId, playerId, currency: 'BRL', createdAt: now });
      wallet.credit('tx-0', Money.from({ amount: '100.00', currency: 'BRL' }), now);

      const debit = Money.from({ amount: '40.00', currency: 'BRL' });
      const txId = 'tx-1';

      const entry = wallet.debit(txId, debit, now);

      expect(wallet.balance.amount).toBe('60.00');
      expect(wallet.version).toBe(3);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.money.amount).toBe('40.00');
      expect(entry.balanceBefore.amount).toBe('100.00');
      expect(entry.balanceAfter.amount).toBe('60.00');
      expect(entry.isBalanced()).toBe(true);
    });

    it('throws InsufficientBalanceError when debit exceeds balance', () => {
      const wallet = Wallet.open({ id: walletId, playerId, currency: 'BRL', createdAt: now });
      wallet.credit('tx-0', Money.from({ amount: '50.00', currency: 'BRL' }), now);

      const excessiveDebit = Money.from({ amount: '50.01', currency: 'BRL' });
      expect(() => wallet.debit('tx-1', excessiveDebit, now)).toThrow(InsufficientBalanceError);
      // Balance and version must remain intact
      expect(wallet.balance.amount).toBe('50.00');
      expect(wallet.version).toBe(2);
    });

    it('throws CurrencyMismatchError on credit or debit with different currency', () => {
      const wallet = Wallet.open({ id: walletId, playerId, currency: 'BRL', createdAt: now });
      const usdMoney = Money.from({ amount: '50.00', currency: 'USD' });

      expect(() => wallet.credit('tx-1', usdMoney, now)).toThrow(CurrencyMismatchError);
      expect(() => wallet.debit('tx-2', usdMoney, now)).toThrow(CurrencyMismatchError);
    });

    it('rehydrates correctly from persistence state', () => {
      const rehydrated = Wallet.rehydrate({
        id: walletId,
        playerId,
        currency: 'BRL',
        balanceAmount: '250.75',
        version: 5,
        createdAt: now,
        updatedAt: now,
      });

      expect(rehydrated.id).toBe(walletId);
      expect(rehydrated.balance.amount).toBe('250.75');
      expect(rehydrated.version).toBe(5);
    });
  });

  describe('WalletLedgerEntry', () => {
    it('throws InvalidLedgerEntryError if arithmetic is unbalanced', () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: 'le-1',
          walletId,
          transactionId: 'tx-1',
          direction: LedgerDirection.Debit,
          money: Money.from({ amount: '20.00', currency: 'BRL' }),
          balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
          balanceAfter: Money.from({ amount: '85.00', currency: 'BRL' }), // wrong arithmetic!
          createdAt: now,
        }),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rehydrates ledger entry from persistence without recalculating', () => {
      const entry = WalletLedgerEntry.rehydrate({
        id: 'le-1',
        walletId,
        transactionId: 'tx-1',
        direction: LedgerDirection.Credit,
        moneyAmount: '10.00',
        moneyCurrency: 'BRL',
        balanceBeforeAmount: '90.00',
        balanceBeforeCurrency: 'BRL',
        balanceAfterAmount: '100.00',
        balanceAfterCurrency: 'BRL',
        createdAt: now,
      });

      expect(entry.id).toBe('le-1');
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.isBalanced()).toBe(true);
    });
  });
});
