import { describe, it, expect, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../shared/infrastructure/database/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { InfrastructureUnavailableError } from '../../shared/application/ports/unit-of-work.port';
import { DomainExceptionFilter } from '../../shared/infrastructure/http/domain-exception.filter';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction.entity';
import { generateId } from '../../shared/domain/identifier';

/** PostgreSQL down / unreachable is a transient failure (503 + Retry-After), never a 500. */
describe('PostgreSQL unavailable', () => {
  let orm: MikroORM | undefined;

  afterAll(async () => {
    await orm?.close(true);
  });

  it('a real connection failure surfaces as InfrastructureUnavailableError from the unit of work', async () => {
    orm = await MikroORM.init({
      ...config,
      clientUrl: 'postgresql://jungle:jungle_secret@127.0.0.1:1/wagering', // nothing listens on port 1
      connect: false,
      pool: { min: 0, max: 1, acquireTimeoutMillis: 2000 },
    });
    const useCase = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm.em));
    const err = await useCase
      .execute({
        providerId: 'p',
        externalTransactionId: 'e-' + generateId(),
        idempotencyKey: 'k-' + generateId(),
        playerId: generateId(),
        walletId: generateId(),
        roundId: 'r',
        gameId: 'g',
        kind: WagerTransactionKind.Bet,
        money: { amount: '1.00', currency: 'BRL' },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(InfrastructureUnavailableError);
  });

  it('the HTTP filter answers 503 with Retry-After for it', () => {
    let status = 0;
    let body: any;
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => (headers[k] = v),
      status: (s: number) => ((status = s), res),
      json: (b: unknown) => ((body = b), res),
    };
    const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ id: 'corr-1' }) }) };
    new DomainExceptionFilter().catch(new InfrastructureUnavailableError('postgresql'), host);
    expect(status).toBe(503);
    expect(headers['Retry-After']).toBe('1');
    expect(body.error).toBe('SERVICE_UNAVAILABLE');
  });
});
