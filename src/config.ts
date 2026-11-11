import { z } from 'zod';

// A SHA-256 hex digest, optionally followed by a scope: `<digest>:read`.
const apiKeyEntry = /^[a-f0-9]{64}(:(read|write))?$/;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  API_KEY_HASHES: z
    .string()
    .transform((value) => value.split(',').map((hash) => hash.trim().toLowerCase()))
    .pipe(
      z
        .array(
          z
            .string()
            .regex(apiKeyEntry, 'must be a SHA-256 hex digest, optionally followed by :read'),
        )
        .min(1),
    ),
  HOLD_EXPIRY_SWEEP_SECONDS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema>;

/** Reads configuration from the environment and fails fast on anything invalid. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
