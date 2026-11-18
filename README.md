# Thesis Market

A social trading layer on Gemini Prediction Markets: every bet is published with a thesis, and anyone can copy it. Built for the UBC 2026 hackathon. All money is test money: simulated fills at Gemini's live prices, and testnet USDC on Arc.

**Status: Phase 1 (market data and the Markets tab).** The price recorder runs on a 30-second poll plus a live WebSocket stream, and the Markets tab shows live odds with a chart for each tracked market. Trading, agents, the auditor, the escrow and copy trade come in later phases. The full README (architecture, trust assumptions, what is simulated) is written in Phase 7.

## Layout

```
apps/web/          Next.js app and API routes (so far: the Markets tab, /api/markets, /api/health)
apps/worker/       Always-on Node worker (so far: the price recorder, by poll and by stream)
packages/core/     Gemini schemas, public client and stream messages, ticker rules, tracked markets
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
| `pnpm verify:gemini` | Checks every "Verify" item in the build plan against the live services. `--write` refreshes `docs/gemini-findings.md` |
| `pnpm verify:gemini --order` | Also places one small order in Gemini's **sandbox**. Needs `GEMINI_SANDBOX_API_KEY` and `GEMINI_SANDBOX_API_SECRET` |
| `pnpm db:generate` | Generates a migration after a schema change |

## Deploy

- **Database:** a Supabase Postgres project. Use the pooled connection string as `DATABASE_URL`.
- **Worker:** Railway, from the repository root. The root `start` script runs the worker, and Railway's builder needs it to find the start command. Set `DATABASE_URL`. The worker applies migrations when it starts.
- **Web:** Vercel, with the root directory set to `apps/web`. Set `DATABASE_URL` and `TRADING_MODE=paper`.

`GET /api/health` on the web app reports how many tracked contracts received price points in the last five minutes.

## How prices are recorded and shown

- The worker polls each tracked event every 30 seconds (`source = rest`) and holds one WebSocket to Gemini with a `bookTicker` subscription per tracked contract (`source = ws`, at most one row per contract every 10 seconds, and none while the quote is unchanged).
- If the socket drops or goes silent, the worker reconnects after 1, 2, 4 and up to 30 seconds and subscribes again. The poll keeps recording in the meantime.
- Gemini's API returns no price history, so each chart starts when recording started.
- The Markets tab shows what Gemini's own site shows: the price to buy YES and the price to buy NO. The chart line is the midpoint of the YES bid and ask.
- Pages re-read their data every 5 seconds, so prices and charts update without a reload.

## Secrets

Secrets live in environment variables only. `.env` is ignored by git. No Gemini secret, Circle entity secret or chain key is ever sent to the browser.
