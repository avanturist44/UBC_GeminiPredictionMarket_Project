# Thesis Market

A social trading layer on Gemini Prediction Markets: every bet is published with a thesis, and anyone can copy it. Built for the UBC 2026 hackathon. All money is test money: simulated fills at Gemini's live prices, and testnet USDC on Arc.

**Status: Phase 0 (verify and scaffold).** The workspace, the database schema and a minimal price recorder exist. Feeds, agents, the auditor, the escrow and copy trade come in later phases. The full README (architecture, trust assumptions, what is simulated) is written in Phase 7.

## Layout

```
apps/web/          Next.js app and API routes (so far: a recorder status page and /api/health)
apps/worker/       Always-on Node worker (so far: the price recorder)
packages/core/     Gemini schemas and public client, ticker rules, tracked markets
packages/db/       Drizzle schema, migrations, queries
scripts/           verify-gemini.ts
docs/              gemini-findings.md: what the live APIs actually do
```

`apps/extension/` and `contracts/` are added in their own phases.

## Setup

Needs Node 22.4 or newer, pnpm 10 (`corepack enable`), and a Postgres database.

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL
pnpm db:migrate               # creates the eleven tables
pnpm dev:worker               # starts recording prices every 30 seconds
pnpm dev:web                  # http://localhost:3000
```

Other commands:

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit tests, including parsing of recorded Gemini responses and recorder tests on an in-memory Postgres |
| `pnpm typecheck` | Type-checks every package and the scripts |
| `pnpm verify:gemini` | Checks every "Verify" item in the build plan against the live services. `--write` refreshes `docs/gemini-findings.md` |
| `pnpm verify:gemini --order` | Also places one small order in Gemini's **sandbox**. Needs `GEMINI_SANDBOX_API_KEY` and `GEMINI_SANDBOX_API_SECRET` |
| `pnpm db:generate` | Generates a migration after a schema change |

## Deploy

- **Database:** a Supabase Postgres project. Use the pooled connection string as `DATABASE_URL`.
- **Worker:** Railway, from the repository root. `railway.json` sets the start command. Set `DATABASE_URL`. The worker applies migrations when it starts.
- **Web:** Vercel, with the root directory set to `apps/web`. Set `DATABASE_URL` and `TRADING_MODE=paper`.

`GET /api/health` on the web app reports how many tracked contracts received price points in the last five minutes.

## Secrets

Secrets live in environment variables only. `.env` is ignored by git. No Gemini secret, Circle entity secret or chain key is ever sent to the browser.
