import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { errors } from '../domain/errors.js';

/** `read` allows queries and reports. `write` allows everything. */
export type Scope = 'read' | 'write';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The scope a route needs. Routes that do not say are treated as `write`. */
    scope?: Scope;
  }
}

interface ApiKey {
  digest: Buffer;
  scopes: ReadonlySet<Scope>;
}

/** Parses entries of the form `<sha256 hex>` (full access) or `<sha256 hex>:read`. */
export function parseApiKeys(entries: string[]): ApiKey[] {
  return entries.map((entry) => {
    const [hex = '', scope] = entry.split(':');
    return {
      digest: Buffer.from(hex, 'hex'),
      scopes: new Set<Scope>(scope === 'read' ? ['read'] : ['read', 'write']),
    };
  });
}

/**
 * Builds a request hook that requires a valid API key in the `X-API-Key`
 * header, with the scope the route asks for. Only SHA-256 digests of keys are
 * configured, so a leaked config file does not leak a usable key.
 */
export function requireApiKey(entries: string[]) {
  const keys = parseApiKeys(entries);

  return (request: FastifyRequest): Promise<void> => {
    const presented = request.headers['x-api-key'];
    if (typeof presented !== 'string' || presented.length === 0) {
      return Promise.reject(errors.unauthorized());
    }
    const digest = createHash('sha256').update(presented).digest();

    // Compare against every key in constant time, without stopping early, so
    // timing does not reveal which key (if any) matched.
    let matched: ApiKey | undefined;
    for (const key of keys) {
      if (key.digest.length === digest.length && timingSafeEqual(key.digest, digest)) matched = key;
    }
    if (!matched) return Promise.reject(errors.unauthorized());

    const required = request.routeOptions.config.scope ?? 'write';
    return matched.scopes.has(required)
      ? Promise.resolve()
      : Promise.reject(errors.forbidden(required));
  };
}
