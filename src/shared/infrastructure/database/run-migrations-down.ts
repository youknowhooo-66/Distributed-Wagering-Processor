import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';

async function run() {
  console.log('Connecting to PostgreSQL and reverting migration...');
  const orm = await MikroORM.init(config);
  try {
    const migrator = orm.getMigrator();
    await migrator.down();
    console.log('Migration reverted successfully!');
  } finally {
    await orm.close();
  }
}

run().catch((err) => {
  console.error('Migration down failed:', err);
  process.exit(1);
});
