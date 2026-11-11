import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp } from './http/app.js';
import { expireHolds } from './ledger/holds.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const app = await buildApp({ config, pool });

// Release holds whose deadline has passed. Every instance may run this: the
// sweep skips rows another instance is already working on.
const sweep = setInterval(() => {
  expireHolds(pool)
    .then((expired) => {
      if (expired > 0) app.log.info({ expired }, 'expired holds released');
    })
    .catch((error: unknown) => {
      app.log.error({ err: error }, 'hold expiry sweep failed');
    });
}, config.HOLD_EXPIRY_SWEEP_SECONDS * 1000);

// Finish in-flight requests, then release the database, before exiting.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  clearInterval(sweep);
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
