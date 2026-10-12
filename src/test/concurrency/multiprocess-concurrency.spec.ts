import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import mikroOrmConfig from '../../shared/infrastructure/database/mikro-orm.config';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../wallet/application/use-cases/reconcile-wallet.use-case';
import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository';
import { generateId } from '../../shared/domain/identifier';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';

describe('Real Multi-Process Concurrency — 3 Bun Processes Disputing Single Wallet', () => {
  let orm: MikroORM;
  let openWalletUseCase: OpenWalletUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    orm = (await CoreMikroORM.init(mikroOrmConfig)) as MikroORM;
    openWalletUseCase = new OpenWalletUseCase(new MikroOrmUnitOfWork(orm.em));
    reconcileWalletUseCase = new ReconcileWalletUseCase(new WalletRepository(orm.em));
  });

  afterAll(async () => {
    await orm.close(true);
  });

  it('spawns 3 separate OS processes executing bets against the same wallet: guarantees zero balance drift and ledger consistency', async () => {
    const playerId = generateId();
    // Initial balance: 600.00 BRL
    const wallet = await openWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '600.00', currency: 'BRL' },
    });

    // Worker child script code
    const workerScript = `
      import { MikroORM } from '@mikro-orm/postgresql';
      import { MikroORM as CoreMikroORM } from '@mikro-orm/core';
      import mikroOrmConfig from './src/shared/infrastructure/database/mikro-orm.config';
      import { ProcessWagerTransactionUseCase } from './src/wagering/application/use-cases/process-wager-transaction.use-case';
      import { MikroOrmUnitOfWork } from './src/shared/infrastructure/database/mikro-orm-unit-of-work';
      import { WagerTransactionKind } from './src/wagering/domain/wager-transaction.entity';
      import { generateId } from './src/shared/domain/identifier';

      const walletId = process.argv[1];
      const playerId = process.argv[2];
      const count = Number(process.argv[3] || '10');

      const orm = await CoreMikroORM.init(mikroOrmConfig);
      const useCase = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm.em));

      let processed = 0;
      let rejected = 0;
      let error503 = 0;

      for (let i = 0; i < count; i++) {
        try {
          const res = await useCase.execute({
            providerId: 'proc-worker',
            externalTransactionId: 'worker-ext-' + process.pid + '-' + i + '-' + generateId(),
            idempotencyKey: 'worker-key-' + process.pid + '-' + i + '-' + generateId(),
            playerId,
            walletId,
            roundId: 'round-' + process.pid,
            gameId: 'game-multiprocess',
            kind: WagerTransactionKind.Bet,
            money: { amount: '10.00', currency: 'BRL' }
          });
          if (res.status === 'PROCESSED') processed++;
          else rejected++;
        } catch (err: any) {
          if (err.status === 503 || err.message?.includes('Concurrency limit exceeded')) {
            error503++;
          }
        }
      }

      await orm.close(true);
      console.log(JSON.stringify({ pid: process.pid, processed, rejected, error503 }));
    `;

    // Run 3 separate OS processes in parallel, each doing 10 bets
    const runProcess = (): Promise<{ pid: number; processed: number; rejected: number; error503: number }> => {
      return new Promise((resolve, reject) => {
        const proc = spawn('bun', ['-e', workerScript, wallet.id, playerId, '10'], {
          cwd: process.cwd(),
          env: process.env,
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));

        proc.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Process failed with code ${code}: ${stderr}`));
          } else {
            try {
              const lines = stdout.trim().split('\n');
              const jsonLine = lines[lines.length - 1];
              resolve(JSON.parse(jsonLine ?? ''));
            } catch (parseErr) {
              reject(new Error(`Failed to parse process output: ${stdout}`));
            }
          }
        });
      });
    };

    const results = await Promise.all([runProcess(), runProcess(), runProcess()]);

    const totalProcessed = results.reduce((sum, r) => sum + r.processed, 0);
    const total503 = results.reduce((sum, r) => sum + r.error503, 0);

    console.log(`[MULTI-PROCESS RESULTS] 3 Processes | Total Processed: ${totalProcessed} | Total 503: ${total503}`);

    // Verify mathematical ledger invariant
    const reconcileResult = await reconcileWalletUseCase.execute(wallet.id);
    const expectedRemaining = (600 - totalProcessed * 10).toFixed(2);

    expect(reconcileResult.consistent).toBe(true);
    expect(reconcileResult.storedBalance.amount).toBe(expectedRemaining);
    expect(reconcileResult.calculatedBalance.amount).toBe(expectedRemaining);
  });
});
