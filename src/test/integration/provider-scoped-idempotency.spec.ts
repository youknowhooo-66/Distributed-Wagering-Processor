import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../shared/infrastructure/database/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.entity';
import { IdempotencyConflictError } from '../../shared/domain/errors';
import { generateId } from '../../shared/domain/identifier';

/**
 * Idempotency keys are chosen by each provider, so they are only unique per provider:
 * one provider must never occupy, replay or conflict with another provider's key.
 */
describe('Idempotency keys scoped by provider', () => {
  let orm: MikroORM;
  let openWallet: OpenWalletUseCase;
  let processWager: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    const uow = new MikroOrmUnitOfWork(orm.em);
    openWallet = new OpenWalletUseCase(uow);
    processWager = new ProcessWagerTransactionUseCase(uow);
  });

  afterAll(async () => {
    await orm.close();
  });

  async function betFor(providerId: string, idempotencyKey: string) {
    const playerId = generateId();
    const wallet = await openWallet.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const cmd = {
      providerId,
      externalTransactionId: 'bet-' + generateId(),
      idempotencyKey,
      playerId,
      walletId: wallet.id,
      roundId: 'r1',
      gameId: 'g1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };
    return { cmd, result: await processWager.execute(cmd) };
  }

  it('two providers using the same key process independently', async () => {
    const sharedKey = 'shared-key-' + generateId();
    const a = await betFor('prov-scope-a', sharedKey);
    const b = await betFor('prov-scope-b', sharedKey);

    expect(a.result.status).toBe(WagerTransactionStatus.Processed);
    expect(b.result.status).toBe(WagerTransactionStatus.Processed);
    expect(b.result.idempotentReplay).toBe(false);
    expect(b.result.transactionId).not.toBe(a.result.transactionId);
  });

  it('within one provider the key still deduplicates and detects conflicts', async () => {
    const key = 'own-key-' + generateId();
    const { cmd, result } = await betFor('prov-scope-c', key);

    const replay = await processWager.execute(cmd);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(result.transactionId);

    await expect(
      processWager.execute({ ...cmd, money: { amount: '20.00', currency: 'BRL' } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
