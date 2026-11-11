import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const digest = 'b'.repeat(64);
const base = { DATABASE_URL: 'postgres://user:pass@localhost:5432/db', API_KEY_HASHES: digest };

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      PORT: 3000,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
  });

  it('accepts several keys, with or without a scope', () => {
    const config = loadConfig({ ...base, API_KEY_HASHES: `${digest}, ${digest}:read` });
    expect(config.API_KEY_HASHES).toEqual([digest, `${digest}:read`]);
  });

  it('refuses to start without a database URL', () => {
    expect(() => loadConfig({ API_KEY_HASHES: digest })).toThrow(/DATABASE_URL/);
  });

  it('refuses a key that is not a SHA-256 digest', () => {
    expect(() => loadConfig({ ...base, API_KEY_HASHES: 'plain-text-key' })).toThrow(
      /API_KEY_HASHES/,
    );
  });

  it('refuses an unknown scope', () => {
    expect(() => loadConfig({ ...base, API_KEY_HASHES: `${digest}:admin` })).toThrow(
      /API_KEY_HASHES/,
    );
  });
});
