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
  pool: { max: Number(process.env.DB_POOL_MAX) || 10 },
  // Session setting sent at connect time: no SET LOCAL round trip per transaction, and an
  // invalid value is rejected by PostgreSQL when the first connection opens.
  driverOptions: { connection: { options: `-c lock_timeout=${process.env.DB_LOCK_TIMEOUT_MS || '5000ms'}` } },
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
