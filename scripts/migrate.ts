import 'dotenv/config';
import { runMigrations } from '../src/server/db/migrationRunner.js';

runMigrations().catch((err) => {
  console.error('[migrate] FATAL execution error:', err.message);
  process.exit(1);
});
