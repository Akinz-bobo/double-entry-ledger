import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '../../src/http/openapi.js';
import { createTestApp, createTestPool } from './helpers.js';

const pool = createTestPool();
let app: FastifyInstance;
const registered: string[] = [];

beforeAll(async () => {
  app = await createTestApp(pool, (instance) => {
    instance.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        // Fastify writes path parameters as :name, OpenAPI as {name}.
        registered.push(`${method} ${route.url.replace(/:(\w+)/g, '{$1}')}`);
      }
    });
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const isDocsRoute = (route: string) => route.split(' ')[1]?.startsWith('/docs') ?? false;

describe('OpenAPI document', () => {
  it('describes exactly the routes the service exposes', async () => {
    const document = await loadOpenApiDocument();
    const documented = Object.entries(document.paths).flatMap(([url, operations]) =>
      Object.keys(operations).map((method) => `${method.toUpperCase()} ${url}`),
    );

    const exposed = registered.filter((route) => !isDocsRoute(route));
    expect(documented.sort()).toEqual(exposed.sort());
  });

  it('is served as JSON for client generators', async () => {
    const response = await app.inject({ url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const served = response.json<{ openapi: string; info: { title: string } }>();
    expect(served.openapi).toBe('3.0.3');
    expect(served.info.title).toBe('Double-Entry Ledger API');
  });

  it('serves Swagger UI', async () => {
    const response = await app.inject({ url: '/docs' });
    expect(response.statusCode).toBeLessThan(400);
  });
});
