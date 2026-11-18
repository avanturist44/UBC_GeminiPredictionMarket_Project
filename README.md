# Thesis Market

A social trading layer on Gemini Prediction Markets: every bet is published with a thesis, and anyone can copy it. Built for the UBC 2026 hackathon. All money is test money: simulated fills at Gemini's live prices, and testnet USDC on Arc.

**Status on `avi/ubc-hack`: Phase 2 BTC paper execution implemented; live acceptance pending.** The Markets tab and live recorder are available from Phase 1. The BTC worker now executes simulated YES/NO trades, publishes deterministic numeric theses, enforces limits, and settles from Gemini's official outcome. All 155 tests and the repository typecheck passed. Live Gemini input and an official outcome were checked, and a read-only hosted database connection succeeded. An isolated local Postgres instance is now configured for live-data paper verification; three qualifying live paper fills and settlement remain pending. See [BTC worker details and verification](docs/btc-paper-worker.md).

### Gemini, the trading agent, and Circle

See [agent types and current implementation status](docs/agents.md) for the BTC strategy, supporting components, planned AI agents, and remaining verification.

Gemini provides prediction market data and official outcomes. The current BTC agent makes its entry decisions with the deterministic momentum model and simulates fills in Postgres. A Circle wallet and Arc testnet USDC belong to the planned tipping and payout flow; the funded wallet is not yet connected to this worker. A Circle wallet balance does not fund the worker's simulated $1,000 paper bankroll or submit a Gemini order.

The architecture leaves the LLM provider open. Grok/Grokbot is not currently installed or configured on either branch. An AI reasoning or tool-calling layer, Circle escrow, AI auditing, and copy-trade integration remain later work. The full product still needs the Circle flow; current paper execution does not complete that integration.

## Layout

```
apps/web/          Next.js app and API routes (so far: the Markets tab, /api/markets, /api/health)
apps/worker/       Price recorder, BTC observer, paper execution and settlement, live-data verification
packages/core/     Gemini client and stream schemas, ticker rules, tracked markets, agent limits
packages/db/       Drizzle schema, migrations, queries
scripts/           verify-gemini.ts, circle-setup.ts
docs/              gemini-findings.md: what the live APIs actually do
```

`apps/extension/` and `contracts/` are added in their own phases.

## Setup

Needs Node 22.4 or newer, pnpm 10 (`corepack enable`), and a Postgres database.

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL
pnpm db:migrate               # creates the eleven tables
pnpm dev:worker               # records prices: a poll every 30 seconds and a live stream
pnpm dev:web                  # http://localhost:3000, markets at /markets
```

Other commands:

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit tests, including parsing of recorded Gemini responses and recorder tests on an in-memory Postgres |
| `pnpm typecheck` | Type-checks every package and the scripts |
| `corepack pnpm --filter @thesis/worker verify:btc` | Checks live BTC REST, index, book sizes and a recent official outcome without submitting orders |
| `corepack pnpm --filter @thesis/worker check:btc-paper` | Reads BTC paper-fill, decision-log and settlement progress; exit 2 means acceptance is still pending |
| `pnpm verify:gemini` | Checks every "Verify" item in the build plan against the live services. `--write` refreshes `docs/gemini-findings.md` |
| `pnpm verify:gemini --order` | Also places one small order in Gemini's **sandbox**. Needs `GEMINI_SANDBOX_API_KEY` and `GEMINI_SANDBOX_API_SECRET` |
| `pnpm db:generate` | Generates a migration after a schema change |

## Deploy

- **Database:** a Supabase Postgres project. Use the pooled connection string as `DATABASE_URL`.
- **Worker:** Railway, from the repository root. The root `start` script runs the worker, and Railway's builder needs it to find the start command. Set `DATABASE_URL`. The worker applies migrations when it starts.
- **Web:** Vercel, with the root directory set to `apps/web`. Set `DATABASE_URL` and `TRADING_MODE=paper`.

`GET /api/health` on the web app reports how many tracked contracts received price points in the last five minutes.

### Next: verify the BTC loop on hosted Postgres

Configure the intended Postgres connection as `DATABASE_URL` in an ignored root `.env`. The team's supplied configuration separates local `DATABASE_URL` from hosted `PROD_DATABASE_URL`; preserve that separation unless intentionally choosing to write to the shared database. Keep `TRADING_MODE=paper`, `BTC_BOT_MODE=paper`, and `TRADING_ENABLED=true`. Start with `corepack pnpm start:worker`. The model requires at least 31 completed minute closes before it can enter; allow further contract windows for three qualifying paper trades. A restart clears in-memory warmup. Follow the queries and acceptance checklist in [the BTC worker runbook](docs/btc-paper-worker.md). Do not treat fixture tests as live acceptance or relax the limits to force demonstration trades.

If the worker already runs on Railway, the existing worker service's `DATABASE_URL` variable is the first place to locate the team's connection. Alternatively, use the Supabase project's **Connect** dialog and copy the Postgres connection URI, including the database password. An API URL, publishable key, or service-role API key is not a Postgres `DATABASE_URL`. See the [official connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).

## How prices are recorded and shown

- The worker polls each tracked event every 30 seconds (`source = rest`) and holds one WebSocket to Gemini with a `bookTicker` subscription per tracked contract (`source = ws`, at most one row per contract every 10 seconds, and none while the quote is unchanged).
- If the socket drops or goes silent, the worker reconnects after 1, 2, 4 and up to 30 seconds and subscribes again. The poll keeps recording in the meantime.
- Gemini's API returns no price history, so each chart starts when recording started.
- The Markets tab shows what Gemini's own site shows: the price to buy YES and the price to buy NO. The chart line is the midpoint of the YES bid and ask.
- Pages re-read their data every 5 seconds, so prices and charts update without a reload.

## Secrets

Secrets live in environment variables only. `.env` is ignored by git. No Gemini secret, Circle entity secret or chain key is ever sent to the browser.
