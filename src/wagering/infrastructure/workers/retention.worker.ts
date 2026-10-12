import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PurgeProcessedMessagesUseCase } from '../../application/use-cases/purge-processed-messages.use-case';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly

@Injectable()
export class RetentionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionWorker.name);
  private isRunning = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly intervalMs = Number(process.env.RETENTION_INTERVAL_MS || DEFAULT_INTERVAL_MS);

  constructor(private readonly purgeUseCase: PurgeProcessedMessagesUseCase) {}

  onModuleInit() {
    this.isRunning = true;
    if (process.env.ENABLE_BACKGROUND_POLL !== 'false') {
      this.scheduleNextRun(60_000); // first run after startup settles
    }
  }

  onModuleDestroy() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  private scheduleNextRun(delayMs: number) {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      try {
        await this.purgeUseCase.execute();
      } catch (err) {
        this.logger.error(`Error in RetentionWorker: ${err}`);
      } finally {
        this.scheduleNextRun(this.intervalMs);
      }
    }, delayMs);
  }
}
