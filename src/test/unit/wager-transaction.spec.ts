import { describe, it, expect } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction.entity';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry.entity';
import { Money } from '../../shared/domain/value-objects';
import { InvalidTransactionStateError, FailureCode } from '../../shared/domain/errors';

describe('WagerTransaction Entity', () => {
  const baseProps = {
    id: '0192f298-345e-7e38-af88-e43f851a819d',
    providerId: 'provider-a',
    externalTransactionId: 'tx-123',
    idempotencyKey: 'provider-a:tx-123',
    payloadHash: 'hash-abc',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: new Date('2026-07-29T15:00:00.000Z'),
  };

  describe('creation and invariants', () => {
    it('creates in PENDING state', () => {
      const tx = WagerTransaction.create(baseProps);
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.affectsBalance()).toBe(true);
      expect(tx.requiresReference()).toBe(false);
    });

    it('requires reference for REFUND and ROLLBACK', () => {
      expect(() =>
        WagerTransaction.create({
          ...baseProps,
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: undefined,
        }),
      ).toThrow();

      expect(() =>
        WagerTransaction.create({
          ...baseProps,
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: undefined,
        }),
      ).toThrow();
    });

    it('recognizes LOSS does not affect balance', () => {
      const tx = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Loss,
      });
      expect(tx.affectsBalance()).toBe(false);
    });
  });

  describe('state transitions', () => {
    it('transitions from PENDING to PROCESSED', () => {
      const tx = WagerTransaction.create(baseProps);
      const processedAt = new Date('2026-07-29T15:00:01.000Z');
      tx.markProcessed(undefined, processedAt);

      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.processedAt).toEqual(processedAt);
    });

    it('transitions from PENDING to REJECTED', () => {
      const tx = WagerTransaction.create(baseProps);
      tx.reject(FailureCode.INSUFFICIENT_BALANCE);

      expect(tx.status).toBe(WagerTransactionStatus.Rejected);
      expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);
      expect(tx.isTerminal()).toBe(true);
    });

    it('transitions from PENDING to PENDING_REFERENCE and then PROCESSED', () => {
      const tx = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ref-1',
      });
      tx.markPendingReference();
      expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
      expect(tx.isTerminal()).toBe(false);

      tx.markProcessed('internal-ref-id', new Date());
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.referenceTransactionId).toBe('internal-ref-id');
    });

    it('throws InvalidTransactionStateError if attempting transition from terminal status', () => {
      const tx = WagerTransaction.create(baseProps);
      tx.markProcessed(undefined, new Date());

      expect(() => tx.reject(FailureCode.INSUFFICIENT_BALANCE)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markProcessed(undefined, new Date())).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markPendingReference()).toThrow(
        InvalidTransactionStateError,
      );
    });
  });

  describe('ledger direction resolution', () => {
    it('determines BET direction as DEBIT', () => {
      const tx = WagerTransaction.create(baseProps);
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    });

    it('determines WIN direction as CREDIT', () => {
      const tx = WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Win });
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it('determines REFUND direction as CREDIT', () => {
      const tx = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ref-bet',
      });
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it('determines ROLLBACK direction as inverse of reference', () => {
      const betTx = WagerTransaction.create(baseProps);
      const rollbackBet = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'tx-123',
      });
      expect(rollbackBet.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);

      const winTx = WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Win });
      const rollbackWin = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'win-tx',
      });
      expect(rollbackWin.ledgerDirectionFor(winTx)).toBe(LedgerDirection.Debit);
    });

    it('throws when determining ledger direction for LOSS', () => {
      const tx = WagerTransaction.create({ ...baseProps, kind: WagerTransactionKind.Loss });
      expect(() => tx.ledgerDirectionFor()).toThrow();
    });
  });

  describe('retry backoff calculation', () => {
    it('schedules retry with exponential backoff', () => {
      const tx = WagerTransaction.create(baseProps);
      const t0 = new Date('2026-07-29T15:00:00.000Z');

      tx.scheduleRetry(t0);
      expect(tx.retryCount).toBe(1);
      // 1000 * 2^1 = 2000ms
      expect(tx.nextRetryAt?.getTime()).toBe(t0.getTime() + 2000);

      tx.scheduleRetry(t0);
      expect(tx.retryCount).toBe(2);
      // 1000 * 2^2 = 4000ms
      expect(tx.nextRetryAt?.getTime()).toBe(t0.getTime() + 4000);
    });
  });
});
