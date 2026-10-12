import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { generateId } from '../../shared/domain/identifier';

describe('HTTP Comprehensive Integration Suite — All Endpoints & Status Codes', () => {
  let app: INestApplication;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    try {
      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(0);
      port = (app.getHttpServer().address() as any).port;
      baseUrl = `http://localhost:${port}`;
    } catch (e) {
      console.error('ERROR in beforeAll:', e);
      throw e;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live returns 200 ok', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('GET /health/ready returns 200 with postgres and sqs status', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.postgresql.status).toBe('ok');
    expect(body.checks.sqs.status).toBe('ok');
  });

  it('GET /metrics returns 200 with text/plain prometheus format', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('wagering_');
  });

  it('POST /wallets returns 201 with created wallet and version 1', async () => {
    const playerId = generateId();
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '500.00', currency: 'BRL' },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.playerId).toBe(playerId);
    expect(body.balance.amount).toBe('500.00');
    expect(body.version).toBe(1);
  });

  it('GET /wallets/:walletId returns 200 with wallet state', async () => {
    const playerId = generateId();
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '150.00', currency: 'BRL' },
      }),
    });
    const wallet = await createRes.json();

    const getRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.id).toBe(wallet.id);
    expect(getBody.balance.amount).toBe('150.00');
  });

  it('GET /wallets/:walletId/ledger returns 200 with paginated entries', async () => {
    const playerId = generateId();
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '200.00', currency: 'BRL' },
      }),
    });
    const wallet = await createRes.json();

    const ledgerRes = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=10`);
    expect(ledgerRes.status).toBe(200);
    const ledger = await ledgerRes.json();
    // API returns { entries: [...], nextCursor: null }
    expect(ledger.entries).toBeDefined();
    expect(ledger.entries.length).toBe(1);
    expect(ledger.entries[0].direction).toBe('CREDIT');
  });

  it('POST /wallets/:walletId/reconciliation returns 200 with isConsistent true', async () => {
    const playerId = generateId();
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '300.00', currency: 'BRL' },
      }),
    });
    const wallet = await createRes.json();

    const reconRes = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });
    expect(reconRes.status).toBe(200);
    const recon = await reconRes.json();
    // API returns { consistent: bool, storedBalance, calculatedBalance, difference, checkedEntries }
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('300.00');
    expect(recon.calculatedBalance.amount).toBe('300.00');
  });

  it('POST /wagering/transactions returns 200 for processed BET and consulta by provider/externalId', async () => {
    const playerId = generateId();
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    const wallet = await createRes.json();

    const providerId = 'prov-http-suite';
    const extTxId = 'bet-http-' + generateId();
    const wagerRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-' + extTxId,
      },
      body: JSON.stringify({
        providerId,
        externalTransactionId: extTxId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      }),
    });

    expect(wagerRes.status).toBe(200);
    const wagerBody = await wagerRes.json();
    expect(wagerBody.status).toBe('PROCESSED');
    expect(wagerBody.transactionId).toBeDefined();

    // Consulta por transactionId
    const getByIdRes = await fetch(`${baseUrl}/wagering/transactions/${wagerBody.transactionId}`);
    expect(getByIdRes.status).toBe(200);
    const byId = await getByIdRes.json();
    expect(byId.id).toBe(wagerBody.transactionId);

    // Consulta por provider e externalTransactionId
    const getByExtRes = await fetch(
      `${baseUrl}/providers/${providerId}/wagering/transactions/${extTxId}`,
    );
    expect(getByExtRes.status).toBe(200);
    const byExt = await getByExtRes.json();
    expect(byExt.id).toBe(wagerBody.transactionId);
    expect(byExt.externalTransactionId).toBe(extTxId);
  });

  it('POST /wagering/transactions returns 202 ACCEPTED for out-of-order PENDING_REFERENCE', async () => {
    const playerId = generateId();
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    const wallet = await createRes.json();

    const providerId = 'prov-http-suite';
    const nonExistentBet = 'bet-missing-' + generateId();
    const refundExtId = 'refund-ooo-' + generateId();

    const refundRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-' + refundExtId,
      },
      body: JSON.stringify({
        providerId,
        externalTransactionId: refundExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-ooo',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: nonExistentBet,
      }),
    });

    expect(refundRes.status).toBe(202);
    const refundBody = await refundRes.json();
    expect(refundBody.status).toBe('PENDING_REFERENCE');
  });

  it('POST /wagering/transactions returns 422 UNPROCESSABLE_ENTITY for domain rejection (insufficient balance)', async () => {
    const playerId = generateId();
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }),
    });
    const wallet = await createRes.json();

    const extTxId = 'bet-excess-' + generateId();
    const wagerRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-' + extTxId,
      },
      body: JSON.stringify({
        providerId: 'prov-http-suite',
        externalTransactionId: extTxId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '100.00', currency: 'BRL' },
      }),
    });

    expect(wagerRes.status).toBe(422);
    const body = await wagerRes.json();
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('INSUFFICIENT_BALANCE');
  });

  it('POST /wagering/transactions returns 422 with REVERSAL_INSUFFICIENT_BALANCE when ROLLBACK of WIN would cause negative balance (Regra 9)', async () => {
    const playerId = generateId();
    // 1. Criar wallet com saldo 50.00 BRL
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      }),
    });
    const wallet = await createRes.json();

    const providerId = 'prov-reversal-rule9';

    // 2. BET: 50.00 BRL (saldo fica 0.00 BRL)
    const betExtId = 'bet-r9-' + generateId();
    const betRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-' + betExtId,
      },
      body: JSON.stringify({
        providerId,
        externalTransactionId: betExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-r9',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      }),
    });
    expect(betRes.status).toBe(200);

    // 3. WIN: 100.00 BRL (saldo fica 100.00 BRL)
    const winExtId = 'win-r9-' + generateId();
    const winRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-' + winExtId,
      },
      body: JSON.stringify({
        providerId,
        externalTransactionId: winExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-r9',
        gameId: 'game-1',
        kind: 'WIN',
        money: { amount: '100.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      }),
    });
    expect(winRes.status).toBe(200);

    // 4. Saque (BET de 100.00 BRL para consumir o saldo -> saldo fica 0.00 BRL)
    const saqueExtId = 'saque-r9-' + generateId();
    const saqueRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-' + saqueExtId,
      },
      body: JSON.stringify({
        providerId,
        externalTransactionId: saqueExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-r9-saque',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '100.00', currency: 'BRL' },
      }),
    });
    expect(saqueRes.status).toBe(200);

    // 5. ROLLBACK da WIN (100.00 BRL) -> deixaria saldo em -100.00 BRL -> REJECTED com REVERSAL_INSUFFICIENT_BALANCE
    const rollbackExtId = 'rollback-r9-' + generateId();
    const rollbackRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-' + rollbackExtId,
      },
      body: JSON.stringify({
        providerId,
        externalTransactionId: rollbackExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-r9',
        gameId: 'game-1',
        kind: 'ROLLBACK',
        money: { amount: '100.00', currency: 'BRL' },
        referenceExternalTransactionId: winExtId,
      }),
    });

    expect(rollbackRes.status).toBe(422);
    const rollbackBody = await rollbackRes.json();
    expect(rollbackBody.status).toBe('REJECTED');
    expect(rollbackBody.failureCode).toBe('REVERSAL_INSUFFICIENT_BALANCE');

    // 6. Validar que o saldo continua 0.00 BRL e que não houve lançamento para o rollback rejeitado
    const walletCheck = await fetch(`${baseUrl}/wallets/${wallet.id}`).then((r) => r.json());
    expect(walletCheck.balance.amount).toBe('0.00');

    // 7. Ledger imutável e consistente
    const reconRes = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' }).then((r) => r.json());
    expect(reconRes.consistent).toBe(true);
    expect(reconRes.storedBalance.amount).toBe('0.00');
    expect(reconRes.calculatedBalance.amount).toBe('0.00');
  });

  it('POST /wagering/transactions returns 400 Bad Request on invalid payload', async () => {
    const res = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /wallets/:walletId returns 404 Not Found on nonexistent wallet', async () => {
    const randomUuid = generateId();
    const res = await fetch(`${baseUrl}/wallets/${randomUuid}`);
    expect(res.status).toBe(404);
  });

  it('POST /wagering/transactions returns 409 Conflict on idempotency key payload collision', async () => {
    const playerId = generateId();
    const createRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    const wallet = await createRes.json();

    const idemKey = 'key-shared-' + generateId();
    const providerId = 'prov-http-409';

    const sharedExtId = 'ext-shared-' + generateId();

    // First request — establishes idempotency record
    const res1 = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify({
        providerId,
        externalTransactionId: sharedExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(res1.status).toBe(200);

    // Second request with SAME idempotency key AND same externalTransactionId but different amount
    // This triggers IDEMPOTENCY_CONFLICT because the payload hash differs from the stored record
    const res2 = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      body: JSON.stringify({
        providerId,
        externalTransactionId: sharedExtId, // same externalId but different amount → hash mismatch
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '99.00', currency: 'BRL' }, // different amount triggers conflict
      }),
    });
    expect(res2.status).toBe(409);
  });
});
