import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  GEMINI_PUBLIC_BASE: z.string().url().default('https://api.gemini.com'),
  GEMINI_WS_URL: z.string().url().default('wss://ws.gemini.com'),
  RECORDER_INTERVAL_MS: z.coerce.number().int().min(5000).default(30_000),
});

export type WorkerEnv = z.infer<typeof EnvSchema>;

/** Reads the repo-root .env when present (local development), then validates. */
export function loadEnv(): WorkerEnv {
  const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker environment: ${problems}`);
  }
  return parsed.data;
}
