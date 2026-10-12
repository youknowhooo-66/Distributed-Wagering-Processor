import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletMikroEntity } from '../../../wallet/infrastructure/persistence/wallet.mikro-entity';
import { WalletLedgerEntryMikroEntity } from '../../../wallet/infrastructure/persistence/wallet-ledger-entry.mikro-entity';
import { WagerTransactionMikroEntity } from '../../../wagering/infrastructure/persistence/wager-transaction.mikro-entity';
import { InboxMessageMikroEntity } from '../../../wagering/infrastructure/persistence/inbox-message.mikro-entity';
import { OutboxMessageMikroEntity } from '../../../wagering/infrastructure/persistence/outbox-message.mikro-entity';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL || 'postgresql://jungle:jungle_secret@localhost:5433/wagering',
  entities: [
    WalletMikroEntity,
    WalletLedgerEntryMikroEntity,
    WagerTransactionMikroEntity,
    InboxMessageMikroEntity,
    OutboxMessageMikroEntity,
  ],
  entitiesTs: [
    WalletMikroEntity,
    WalletLedgerEntryMikroEntity,
    WagerTransactionMikroEntity,
    InboxMessageMikroEntity,
    OutboxMessageMikroEntity,
  ],
  extensions: [Migrator],
  allowGlobalContext: true,
  // Under Bun MikroORM detects TS support even when running compiled JS from dist/,
  // which would point the migrator at ./src/migrations (absent in the image).
  preferTs: __filename.endsWith('.ts'),
  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
  },
  debug: process.env.NODE_ENV === 'development',
});
