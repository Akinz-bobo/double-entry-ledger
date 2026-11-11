import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { errors } from '../domain/errors.js';

/**
 * Builds a request hook that requires a valid API key in the `X-API-Key`
 * header. Only SHA-256 digests of keys are configured, so a leaked config
 * file does not leak a usable key. Digests are compared in constant time.
 */
export function requireApiKey(acceptedHashes: string[]) {
  const accepted = acceptedHashes.map((hash) => Buffer.from(hash, 'hex'));

  return (request: FastifyRequest): Promise<void> => {
    const presented = request.headers['x-api-key'];
    if (typeof presented !== 'string' || presented.length === 0) {
      return Promise.reject(errors.unauthorized());
    }
    const digest = createHash('sha256').update(presented).digest();

    // Check every configured key, without stopping early, so timing does not
    // reveal which key (if any) matched.
    let valid = false;
    for (const hash of accepted) {
      if (hash.length === digest.length && timingSafeEqual(hash, digest)) valid = true;
    }
    return valid ? Promise.resolve() : Promise.reject(errors.unauthorized());
  };
}
