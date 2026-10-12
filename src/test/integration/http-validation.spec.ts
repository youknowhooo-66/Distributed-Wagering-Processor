import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { DomainExceptionFilter } from '../../shared/infrastructure/http/domain-exception.filter';
import { generateId } from '../../shared/domain/identifier';

describe('HTTP — wager payload validation (400 instead of 500 / silent acceptance)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let wallet: { id: string; playerId: string };

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);
    baseUrl = `http://localhost:${(app.getHttpServer().address() as { port: number }).port}`;
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: generateId(), initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    wallet = await res.json();
  });

  afterAll(async () => {
    await app.close();
  });

  function submit(override: Record<string, unknown>, headers: Record<string, string> = {}) {
    const ext = 'ext-' + generateId();
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-' + ext, ...headers },
      body: JSON.stringify({
        providerId: 'prov-validation',
        externalTransactionId: ext,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
        ...override,
      }),
    });
  }

  it.each([
    ['unknown kind', { kind: 'BONUS' }],
    ['zero BET', { money: { amount: '0.00', currency: 'BRL' } }],
    ['3 decimal places', { money: { amount: '1.005', currency: 'BRL' } }],
    ['missing roundId', { roundId: undefined }],
    ['non-UUID walletId', { walletId: 'not-a-uuid' }],
    ['REFUND without reference', { kind: 'REFUND' }],
  ])('returns 400 INVALID_PAYLOAD for %s', async (_label, override) => {
    const res = await submit(override);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_PAYLOAD');
    expect(Array.isArray(body.message)).toBe(true);
  });

  it('returns 400 for an Idempotency-Key longer than the column', async () => {
    const res = await submit({}, { 'Idempotency-Key': 'k'.repeat(513) });
    expect(res.status).toBe(400);
  });

  it('still accepts a valid BET and a zero-amount LOSS', async () => {
    expect((await submit({})).status).toBe(200);
    expect((await submit({ kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } })).status).toBe(200);
  });
});
