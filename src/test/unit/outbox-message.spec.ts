import { describe, it, expect } from 'bun:test';
import { OutboxMessage } from '../../wagering/domain/outbox-message.entity';
import { WalletBalanceChanged } from '../../wagering/domain/events/wallet-balance-changed.event';
import { Wallet } from '../../wallet/domain/wallet.entity';
import { Money } from '../../shared/domain/value-objects';

describe('OutboxMessage', () => {
  const at = new Date('2026-07-29T15:00:00.000Z');

  function message(): OutboxMessage {
    const wallet = Wallet.open({ id: 'w-1', playerId: 'p-1', currency: 'BRL', createdAt: at });
    const entry = wallet.credit('tx-1', Money.from({ amount: '10.00', currency: 'BRL' }), at);
    return OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, { correlationId: 'corr-1' }));
  }

  it('backoff doubles from 2s and caps at 60s', () => {
    expect([1, 2, 3, 5, 6, 10].map(OutboxMessage.retryDelayMs)).toEqual([2000, 4000, 8000, 32000, 60000, 60000]);
  });

  it('is due until published, and not due while in backoff', () => {
    const msg = message();
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(at)).toBe(true);
    msg.scheduleRetry(at);
    expect(msg.attempts).toBe(1);
    expect(msg.isDue(new Date(at.getTime() + 1999))).toBe(false);
    expect(msg.isDue(new Date(at.getTime() + 2000))).toBe(true);
    msg.markPublished(at);
    expect(msg.isDue(new Date(at.getTime() + 60_000))).toBe(false);
  });

  it('stores the serialized envelope (MoneyProps strings, ISO dates, type and version)', () => {
    const payload = message().payload as any;
    expect(payload.eventType).toBe('WalletBalanceChanged');
    expect(payload.version).toBe(1);
    expect(payload.correlationId).toBe('corr-1');
    expect(payload.occurredAt).toBe(at.toISOString());
    expect(payload.data.money).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(payload.data.walletVersion).toBe(2);
  });
});
