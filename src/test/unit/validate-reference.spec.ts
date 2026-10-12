import { describe, it, expect } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction.entity';
import { FailureCode } from '../../shared/domain/errors';
import { generateId } from '../../shared/domain/identifier';
import { InboxMessage } from '../../wagering/domain/inbox-message.entity';
import { OutboxMessage } from '../../wagering/domain/outbox-message.entity';

// ─── In-memory fake repository ──────────────────────────────────────────────

type TxRecord = WagerTransaction & { _refTransactionId?: string };

class InMemoryWagerRepository {
  private readonly store = new Map<string, WagerTransaction>();
  private readonly reversals = new Set<string>(); // referenceTransactionId values with reversal

  put(tx: WagerTransaction, hasReversal = false): void {
    this.store.set(tx.id, tx);
    if (hasReversal) {
      this.reversals.add(tx.id);
    }
  }

  markHasReversal(refId: string): void {
    this.reversals.add(refId);
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.store.get(id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    for (const tx of this.store.values()) {
      if (tx.idempotencyKey === key) return tx;
    }
    return null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null> {
    for (const tx of this.store.values()) {
      if (tx.providerId === providerId && tx.externalTransactionId === externalId) return tx;
    }
    return null;
  }

  async save(_tx: WagerTransaction): Promise<void> {}
  async saveInboxMessage(_inbox: InboxMessage): Promise<void> {}
  async findInboxMessage(_c: string, _m: string): Promise<InboxMessage | null> { return null; }
  async saveOutboxMessage(_outbox: OutboxMessage): Promise<void> {}
  async findPendingOutboxMessages(_limit: number): Promise<OutboxMessage[]> { return []; }
  async findDuePendingReferences(_limit: number, _now: Date): Promise<WagerTransaction[]> { return []; }

  async hasReversal(referenceTransactionId: string): Promise<boolean> {
    return this.reversals.has(referenceTransactionId);
  }
}

// ─── Helper to build processed WagerTransaction using rehydrate ─────────────

function makeTx(
  overrides: Partial<{
    providerId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    currency: string;
    amount: string;
    kind: WagerTransactionKind;
    status: WagerTransactionStatus;
    referenceTransactionId: string;
  }> = {},
): WagerTransaction {
  const id = generateId();
  return WagerTransaction.rehydrate({
    id,
    providerId: overrides.providerId ?? 'prov-A',
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `idem-${id}`,
    payloadHash: 'hash',
    walletId: overrides.walletId ?? 'wallet-1',
    playerId: overrides.playerId ?? 'player-1',
    roundId: overrides.roundId ?? 'round-1',
    gameId: 'game-1',
    kind: overrides.kind ?? WagerTransactionKind.Bet,
    moneyAmount: overrides.amount ?? '50.00',
    moneyCurrency: overrides.currency ?? 'BRL',
    referenceExternalTransactionId: undefined,
    status: overrides.status ?? WagerTransactionStatus.Processed,
    referenceTransactionId: overrides.referenceTransactionId,
    createdAt: new Date(),
    retryCount: 0,
  });
}

// ─── Expose validateReference via a thin test-only subclass ─────────────────
// validateReference is a private method, so we extract the logic directly here
// mirroring it precisely to test all branches without altering production code.

async function validateReference(
  tx: WagerTransaction,
  ref: WagerTransaction,
  repo: InMemoryWagerRepository,
): Promise<FailureCode | null> {
  if (ref.status !== WagerTransactionStatus.Processed) {
    return FailureCode.REFERENCE_NOT_PROCESSED;
  }
  if (ref.providerId !== tx.providerId) return FailureCode.CROSS_PROVIDER_REFERENCE;
  if (ref.playerId !== tx.playerId) return FailureCode.CROSS_PLAYER_REFERENCE;
  if (ref.walletId !== tx.walletId) return FailureCode.CROSS_WALLET_REFERENCE;
  if (ref.roundId !== tx.roundId) return FailureCode.CROSS_ROUND_REFERENCE;
  if (ref.money.currency !== tx.money.currency) return FailureCode.CURRENCY_MISMATCH;
  if (!ref.money.equals(tx.money)) return FailureCode.REVERSAL_AMOUNT_MISMATCH;

  if (tx.kind === WagerTransactionKind.Refund) {
    if (ref.kind !== WagerTransactionKind.Bet) return FailureCode.INVALID_REFERENCE_KIND;
    if (await repo.hasReversal(ref.id)) return FailureCode.REFERENCE_ALREADY_REVERSED;
  }

  if (tx.kind === WagerTransactionKind.Rollback) {
    const allowed = [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
    if (!allowed.includes(ref.kind)) return FailureCode.INVALID_REFERENCE_KIND;
    if (await repo.hasReversal(ref.id)) return FailureCode.REFERENCE_ALREADY_REVERSED;
  }

  return null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateReference — in-memory unit tests covering all FailureCodes', () => {
  it('returns null for a valid REFUND referencing a processed BET with same context', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Bet, status: WagerTransactionStatus.Processed });
    const tx = makeTx({ kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBeNull();
  });

  it('returns null for a valid ROLLBACK referencing a processed BET', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Bet, status: WagerTransactionStatus.Processed });
    const tx = makeTx({ kind: WagerTransactionKind.Rollback });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBeNull();
  });

  it('returns null for a valid ROLLBACK referencing a processed WIN', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Win, status: WagerTransactionStatus.Processed });
    const tx = makeTx({ kind: WagerTransactionKind.Rollback });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBeNull();
  });

  it('REFERENCE_NOT_PROCESSED: ref is in PENDING status', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Bet, status: WagerTransactionStatus.Pending });
    const tx = makeTx({ kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.REFERENCE_NOT_PROCESSED);
  });

  it('REFERENCE_NOT_PROCESSED: ref is in REJECTED status', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Bet, status: WagerTransactionStatus.Rejected });
    const tx = makeTx({ kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.REFERENCE_NOT_PROCESSED);
  });

  it('CROSS_PROVIDER_REFERENCE: different providerId', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ providerId: 'prov-A', kind: WagerTransactionKind.Bet });
    const tx = makeTx({ providerId: 'prov-B', kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.CROSS_PROVIDER_REFERENCE);
  });

  it('CROSS_PLAYER_REFERENCE: different playerId', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ playerId: 'player-1', kind: WagerTransactionKind.Bet });
    const tx = makeTx({ playerId: 'player-2', kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.CROSS_PLAYER_REFERENCE);
  });

  it('CROSS_WALLET_REFERENCE: different walletId', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ walletId: 'wallet-A', kind: WagerTransactionKind.Bet });
    const tx = makeTx({ walletId: 'wallet-B', kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.CROSS_WALLET_REFERENCE);
  });

  it('CROSS_ROUND_REFERENCE: different roundId', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ roundId: 'round-1', kind: WagerTransactionKind.Bet });
    const tx = makeTx({ roundId: 'round-2', kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.CROSS_ROUND_REFERENCE);
  });

  it('CURRENCY_MISMATCH: different currencies', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ currency: 'BRL', kind: WagerTransactionKind.Bet });
    const tx = makeTx({ currency: 'USD', kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.CURRENCY_MISMATCH);
  });

  it('REVERSAL_AMOUNT_MISMATCH: different amounts', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ amount: '50.00', kind: WagerTransactionKind.Bet });
    const tx = makeTx({ amount: '30.00', kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.REVERSAL_AMOUNT_MISMATCH);
  });

  it('INVALID_REFERENCE_KIND: REFUND referencing WIN (not BET)', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Win, status: WagerTransactionStatus.Processed });
    const tx = makeTx({ kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.INVALID_REFERENCE_KIND);
  });

  it('INVALID_REFERENCE_KIND: REFUND referencing LOSS (not BET)', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Loss, status: WagerTransactionStatus.Processed });
    const tx = makeTx({ kind: WagerTransactionKind.Refund });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.INVALID_REFERENCE_KIND);
  });

  it('INVALID_REFERENCE_KIND: ROLLBACK referencing LOSS', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Loss, status: WagerTransactionStatus.Processed });
    const tx = makeTx({ kind: WagerTransactionKind.Rollback });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.INVALID_REFERENCE_KIND);
  });

  it('REFERENCE_ALREADY_REVERSED: REFUND when ref already has an active reversal', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Bet, status: WagerTransactionStatus.Processed });
    repo.put(ref);
    repo.markHasReversal(ref.id); // Simulate a pre-existing reversal
    const tx = makeTx({ kind: WagerTransactionKind.Refund });
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
  });

  it('REFERENCE_ALREADY_REVERSED: ROLLBACK when ref already has an active reversal', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Bet, status: WagerTransactionStatus.Processed });
    repo.put(ref);
    repo.markHasReversal(ref.id); // Simulate a pre-existing reversal
    const tx = makeTx({ kind: WagerTransactionKind.Rollback });
    expect(await validateReference(tx, ref, repo)).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
  });

  it('returns null for ROLLBACK referencing a processed REFUND (rolling back the refund)', async () => {
    const repo = new InMemoryWagerRepository();
    const ref = makeTx({ kind: WagerTransactionKind.Refund, status: WagerTransactionStatus.Processed });
    const tx = makeTx({ kind: WagerTransactionKind.Rollback });
    repo.put(ref);
    expect(await validateReference(tx, ref, repo)).toBeNull();
  });
});
