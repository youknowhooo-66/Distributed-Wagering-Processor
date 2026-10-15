import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { LoggerModule } from 'nestjs-pino';
import mikroOrmConfig from './shared/infrastructure/database/mikro-orm.config';
import { SharedModule } from './shared/shared.module';
import { WalletModule } from './wallet/wallet.module';
import { WageringModule } from './wagering/wagering.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || 'info',
        // Access log for failures only: successes are counted by the metrics and recorded in the
        // transactions table, and a log line per request cost ~4% of a replica's CPU under load.
        customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'silent'),
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        // Sanitize sensitive logs
        serializers: {
          req(req) {
            return {
              id: req.id,
              method: req.method,
              url: req.url,
              headers: {
                'idempotency-key': req.headers['idempotency-key'],
                'x-correlation-id': req.headers['x-correlation-id'],
              },
            };
          },
        },
      },
    }),
    MikroOrmModule.forRoot(mikroOrmConfig),
    SharedModule,
    WalletModule,
    WageringModule,
  ],
})
export class AppModule {}
