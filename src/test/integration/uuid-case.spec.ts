import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../shared/infrastructure/database/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.entity';
import { generateId } from '../../shared/domain/identifier';

/**
 * PostgreSQL stores UUIDs lowercase; providers may send them uppercase. The same request in
 * either case must be the same request: same idempotency result, same reference checks.
 */
describe('UUID case — playerId / walletId sent in uppercase', () => {
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

  it('a REFUND with uppercase ids is not rejected as a cross-player/wallet reference', async () => {
    const playerId = generateId();
    const wallet = await openWallet.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const upper = { playerId: playerId.toUpperCase(), walletId: wallet.id.toUpperCase() };
    const base = { providerId: 'prov-uuid-case', roundId: 'r1', gameId: 'g1', ...upper };
    const betId = 'bet-' + generateId();

    const bet = await processWager.execute({
      ...base,
      externalTransactionId: betId,
      idempotencyKey: 'uc:' + betId,
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const refundId = 'refund-' + generateId();
    const refund = await processWager.execute({
      ...base,
      externalTransactionId: refundId,
      idempotencyKey: 'uc:' + refundId,
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: betId,
    });
    expect(refund.failureCode).toBeUndefined();
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance?.amount).toBe('100.00');
  });

  it('the same request with ids in different case is an idempotent replay, not a conflict', async () => {
    const playerId = generateId();
    const wallet = await openWallet.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const ext = 'bet-' + generateId();
    const cmd = {
      providerId: 'prov-uuid-case',
      externalTransactionId: ext,
      idempotencyKey: 'uc:' + ext,
      playerId,
      walletId: wallet.id,
      roundId: 'r1',
      gameId: 'g1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };
    await processWager.execute(cmd);

    const replay = await processWager.execute({
      ...cmd,
      playerId: playerId.toUpperCase(),
      walletId: wallet.id.toUpperCase(),
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance?.amount).toBe('90.00');
  });
});
