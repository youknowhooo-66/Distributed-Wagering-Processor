import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';

async function run() {
  console.log('Connecting to PostgreSQL and running migrations...');
  const orm = await MikroORM.init(config);
  try {
    const migrator = orm.getMigrator();
    await migrator.up();
    console.log('Migrations applied successfully!');
  } finally {
    await orm.close();
  }
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
