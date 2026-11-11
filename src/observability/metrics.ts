import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpRequestDuration: Histogram<'method' | 'route' | 'status'>;
  transactionsPosted: Counter<'kind'>;
  idempotentReplays: Counter;
}

/** Builds a fresh registry, so each app instance (and each test) has its own. */
export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    httpRequestDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
    transactionsPosted: new Counter({
      name: 'ledger_transactions_posted_total',
      help: 'Transactions posted to the ledger',
      labelNames: ['kind'],
      registers: [registry],
    }),
    idempotentReplays: new Counter({
      name: 'ledger_idempotent_replays_total',
      help: 'Requests answered from a stored idempotent response',
      registers: [registry],
    }),
  };
}
