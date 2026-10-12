import { Module, forwardRef } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WagerTransactionMikroEntity } from './infrastructure/persistence/wager-transaction.mikro-entity';
import { InboxMessageMikroEntity } from './infrastructure/persistence/inbox-message.mikro-entity';
import { OutboxMessageMikroEntity } from './infrastructure/persistence/outbox-message.mikro-entity';
import { WagerTransactionRepository } from './infrastructure/persistence/wager-transaction.repository';
import { WAGER_TRANSACTION_REPOSITORY } from './domain/wager-transaction.repository.port';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { GetTransactionUseCase } from './application/use-cases/get-transaction.use-case';
import { RetryPendingReferencesUseCase } from './application/use-cases/retry-pending-references.use-case';
import { OutboxPublisherWorker } from './infrastructure/messaging/outbox-publisher.worker';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager.consumer';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { RetentionWorker } from './infrastructure/workers/retention.worker';
import { PurgeProcessedMessagesUseCase } from './application/use-cases/purge-processed-messages.use-case';
import { WageringController } from './infrastructure/http/wagering.controller';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      WagerTransactionMikroEntity,
      InboxMessageMikroEntity,
      OutboxMessageMikroEntity,
    ]),
    forwardRef(() => WalletModule),
  ],
  controllers: [WageringController],
  providers: [
    WagerTransactionRepository,
    { provide: WAGER_TRANSACTION_REPOSITORY, useExisting: WagerTransactionRepository },
    ProcessWagerTransactionUseCase,
    GetTransactionUseCase,
    RetryPendingReferencesUseCase,
    OutboxPublisherWorker,
    SqsWagerConsumer,
    PendingReferenceWorker,
    PurgeProcessedMessagesUseCase,
    RetentionWorker,
  ],
  exports: [WagerTransactionRepository, ProcessWagerTransactionUseCase],
})
export class WageringModule {}
