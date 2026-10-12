import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RetryPendingReferencesUseCase } from '../../application/use-cases/retry-pending-references.use-case';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private isRunning = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly retryPendingReferencesUseCase: RetryPendingReferencesUseCase,
  ) {}

  onModuleInit() {
    this.isRunning = true;
    if (process.env.ENABLE_BACKGROUND_POLL !== 'false') {
      this.scheduleNextRun(1000);
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
        const resolved = await this.retryPendingReferencesUseCase.execute();
        if (resolved > 0) {
          this.logger.log(`PendingReferenceWorker: processed ${resolved} items`);
        }
      } catch (err) {
        this.logger.error(`Error in PendingReferenceWorker: ${err}`);
      } finally {
        this.scheduleNextRun(2000); // Poll every 2s
      }
    }, delayMs);
  }
}
