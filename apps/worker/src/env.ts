import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARENA_ROSTER } from '@thesis/core';
import { z } from 'zod';

/** An empty value in .env means "not set", so the default applies. */
const blank = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema);

const ARENA_AGENT_KEYS: readonly string[] = ARENA_ROSTER.map((entrant) => entrant.agentKey);
const SandboxKeysSchema = z.object({ apiKey: z.string().min(1), apiSecret: z.string().min(1) });
const AGENT_KEYS_SHAPE = 'a JSON object from arena agent key to { "apiKey": "account-…", "apiSecret": "…" }';

type SandboxKeys = z.infer<typeof SandboxKeysSchema>;

/**
 * GEMINI_AGENT_KEYS: each arena model's Gemini sandbox API key and secret. Several models may
 * share one key. The value holds secrets, so a problem with it is described without quoting it:
 * not even a JSON parse error, whose message quotes the text. Undefined when not set.
 */
const AgentKeysSchema = z
  .string()
  .optional()
  .transform((raw, ctx): Record<string, SandboxKeys> | undefined => {
    const refuse = (problem: string) => {
      ctx.addIssue({ code: 'custom', message: `${problem}; it should be ${AGENT_KEYS_SHAPE}` });
      return z.NEVER;
    };
    if (raw === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return refuse('is not valid JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse('is not a JSON object');
    const keys: Record<string, SandboxKeys> = {};
    const secretOf = new Map<string, string>();
    for (const [agentKey, entry] of Object.entries(value)) {
      // The unknown key itself is not quoted: it could be a key or secret pasted in the wrong place.
      if (!ARENA_AGENT_KEYS.includes(agentKey)) return refuse(`has an entry that is not an arena agent key (${ARENA_AGENT_KEYS.join(', ')})`);
      const parsed = SandboxKeysSchema.safeParse(entry);
      if (!parsed.success) return refuse(`${agentKey} needs a non-empty apiKey and apiSecret`);
      const { apiKey, apiSecret } = parsed.data;
      if ((secretOf.get(apiKey) ?? apiSecret) !== apiSecret) return refuse(`${agentKey} shares an apiKey with another model but not its apiSecret`);
      secretOf.set(apiKey, apiSecret);
      keys[agentKey] = { apiKey, apiSecret };
    }
    return keys;
  });

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
  /** US dollars of model spend allowed per UTC day, across every model call the worker makes. */
  LLM_DAILY_USD_CAP: blank(z.coerce.number().positive().default(25)),
  // The agents search the web on every look, which is where most of the spend goes, so
  // they run on a cheaper model than the auditor and only as often as set here.
  LLM_AGENT_MODEL: blank(z.string().default('claude-sonnet-5-5')),
  /** Which of the model-backed agents run: `arena`, `news`, `fade`, several (comma-separated) or `none`. */
  ENABLED_AGENTS: blank(z.string().default('arena')),
  NEWS_INTERVAL_MINUTES: blank(z.coerce.number().int().min(5).default(60)),
  // The model arena: one trading agent per AI model (packages/core/src/arena.ts). Claude uses
  // LLM_API_KEY; each other model its own vendor's key. A model whose key is not set is left out.
  OPENAI_API_KEY: blank(z.string().optional()),
  /** Google's key, for the Gemini model. Not the Gemini exchange. */
  GEMINI_API_KEY: blank(z.string().optional()),
  XAI_API_KEY: blank(z.string().optional()),
  DEEPSEEK_API_KEY: blank(z.string().optional()),
  /** How often every arena model looks at a market, all at once. Each look is a web-search call per model. */
  ARENA_INTERVAL_MINUTES: blank(z.coerce.number().int().min(15).default(60)),
  /** Input plus output tokens each arena model may use per UTC day, apart from the auditor's budget. */
  ARENA_DAILY_TOKEN_CAP_PER_MODEL: blank(z.coerce.number().int().positive().default(1_000_000)),
  /**
   * US dollars per UTC day the arena may spend, out of LLM_DAILY_USD_CAP: its models' looks and the
   * audits of their theses. The rest of the day's cap is kept for people's audits.
   */
  ARENA_DAILY_USD_CAP: blank(z.coerce.number().positive().default(18)),
  // Each arena model's Gemini sandbox account (models may share one), where its paper trades are
  // also placed as real orders. Absent or {} means no accounts, and the sandbox mirror does not
  // run. Without it, one key pair in the two variables after it is every arena model's (they share
  // one account).
  GEMINI_AGENT_KEYS: blank(AgentKeysSchema),
  GEMINI_AGENT_API_KEY: blank(z.string().optional()),
  GEMINI_AGENT_API_SECRET: blank(z.string().optional()),
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
}).transform((env, ctx) => {
  if (env.ARENA_DAILY_USD_CAP > env.LLM_DAILY_USD_CAP) {
    ctx.addIssue({
      code: 'custom',
      path: ['ARENA_DAILY_USD_CAP'],
      message: `is ${env.ARENA_DAILY_USD_CAP}, more than LLM_DAILY_USD_CAP (${env.LLM_DAILY_USD_CAP}); the arena's cap is a share of the day's, so set it at most that`,
    });
  }
  return { ...env, GEMINI_AGENT_KEYS: sandboxKeys(env, ctx) };
});

/**
 * The sandbox keys by arena agent key: GEMINI_AGENT_KEYS when it is set, otherwise the one pair
 * in GEMINI_AGENT_API_KEY and GEMINI_AGENT_API_SECRET for every model, otherwise none.
 */
function sandboxKeys(
  env: { GEMINI_AGENT_KEYS?: Record<string, SandboxKeys>; GEMINI_AGENT_API_KEY?: string; GEMINI_AGENT_API_SECRET?: string },
  ctx: z.RefinementCtx,
): Record<string, SandboxKeys> {
  if (env.GEMINI_AGENT_KEYS) return env.GEMINI_AGENT_KEYS;
  const { GEMINI_AGENT_API_KEY: apiKey, GEMINI_AGENT_API_SECRET: apiSecret } = env;
  if (apiKey && apiSecret) return Object.fromEntries(ARENA_AGENT_KEYS.map((agentKey) => [agentKey, { apiKey, apiSecret }]));
  if (apiKey || apiSecret) {
    const [set, missing] = apiKey ? ['GEMINI_AGENT_API_KEY', 'GEMINI_AGENT_API_SECRET'] : ['GEMINI_AGENT_API_SECRET', 'GEMINI_AGENT_API_KEY'];
    ctx.addIssue({ code: 'custom', path: [set], message: `is set without ${missing}; set both, or neither` });
  }
  return {};
}

export type WorkerEnv = z.infer<typeof EnvSchema>;

/** Reads the repo-root .env when present (local development), then validates. */
export function loadEnv(): WorkerEnv {
  const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  return parseEnv(process.env);
}

/** Validates the worker's settings from `source`, filling in the defaults. */
export function parseEnv(source: Record<string, string | undefined>): WorkerEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker environment: ${problems}`);
  }
  return parsed.data;
}
