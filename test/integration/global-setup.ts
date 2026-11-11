import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { TEST_DATABASE_URL } from './helpers.js';

/** Runs once before the whole suite: brings the test database up to date. */
export default async function setup(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL, 1);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
