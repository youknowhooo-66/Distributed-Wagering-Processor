import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './shared/infrastructure/http/domain-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger = app.get(Logger);
  app.useLogger(logger);

  // Global domain exception filter
  app.useGlobalFilters(new DomainExceptionFilter());

  // Graceful shutdown. Not app.enableShutdownHooks(): after the hooks it re-raises the signal
  // to terminate, and as PID 1 in a container the kernel ignores it, so the process would only
  // die by SIGKILL at the end of the grace period. Exit explicitly once close() completes.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, async () => {
      logger.log(`${signal} received: closing application`);
      try {
        await app.close();
        process.exit(0);
      } catch (err) {
        logger.error(`Error during shutdown: ${(err as Error).message}`);
        process.exit(1);
      }
    });
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`Application started and listening on port ${port}`);
}

bootstrap();
