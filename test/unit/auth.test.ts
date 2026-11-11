import { describe, expect, it } from 'vitest';
import { parseApiKeys } from '../../src/http/auth.js';

const digest = 'a'.repeat(64);

describe('parseApiKeys', () => {
  it('gives a bare digest full access', () => {
    const [key] = parseApiKeys([digest]);
    expect([...(key?.scopes ?? [])].sort()).toEqual(['read', 'write']);
  });

  it('limits a :read entry to reading', () => {
    const [key] = parseApiKeys([`${digest}:read`]);
    expect([...(key?.scopes ?? [])]).toEqual(['read']);
  });

  it('treats :write as full access, since writing implies reading', () => {
    const [key] = parseApiKeys([`${digest}:write`]);
    expect([...(key?.scopes ?? [])].sort()).toEqual(['read', 'write']);
  });

  it('decodes the digest to bytes', () => {
    const [key] = parseApiKeys([digest]);
    expect(key?.digest).toHaveLength(32);
  });
});
