import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** An empty value in .env means "not set", so the default applies. */
const blank = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema);

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  GEMINI_PUBLIC_BASE: z.string().url().default('https://api.gemini.com'),
  GEMINI_WS_URL: z.string().url().default('wss://ws.gemini.com'),
  TRADING_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  // The language model behind the auditor and the news and fade agents. With no key the
  // auditor runs its phrase screen only and the two agents stay off.
  LLM_PROVIDER: blank(z.enum(['anthropic', 'none']).optional()),
  LLM_MODEL: blank(z.string().default('claude-opus-5-5')),
  LLM_API_KEY: blank(z.string().optional()),
  LLM_EFFORT: blank(z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium')),
  LLM_DAILY_TOKEN_CAP: blank(z.coerce.number().int().positive().default(2_000_000)),
  // The agents search the web on every look, which is where most of the spend goes, so
  // they run on a cheaper model than the auditor and only as often as set here.
  LLM_AGENT_MODEL: blank(z.string().default('claude-sonnet-5-5')),
  /** Which of the model-backed agents run: `news`, `fade`, both (comma-separated) or `none`. */
  ENABLED_AGENTS: blank(z.string().default('news')),
  NEWS_INTERVAL_MINUTES: blank(z.coerce.number().int().min(5).default(60)),
  // The escrow on Arc testnet and the Circle wallets that tip into it. All test money.
  // With any of these missing the worker runs without the on-chain jobs.
  ARC_RPC_URL: blank(z.string().url().default('https://rpc.testnet.arc.io')),
  ARC_CHAIN_ID: blank(z.coerce.number().int().default(5042002)),
  USDC_ADDRESS: blank(z.string().regex(/^0x[0-9a-fA-F]{40}$/).default('0x3600000000000000000000000000000000000000')),
  ESCROW_ADDRESS: blank(z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional()),
  REGISTRAR_KEY: blank(z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()),
  RESOLVER_KEY: blank(z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional()),
  CIRCLE_API_KEY: blank(z.string().optional()),
  CIRCLE_ENTITY_SECRET: blank(z.string().optional()),
  CIRCLE_WALLET_SET_ID: blank(z.string().optional()),
  CIRCLE_TREASURY_WALLET_ID: blank(z.string().optional()),
  /** Test USDC sent once to each new user wallet. */
  WELCOME_USDC: blank(z.string().regex(/^\d+(\.\d{1,2})?$/).default('2')),
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
