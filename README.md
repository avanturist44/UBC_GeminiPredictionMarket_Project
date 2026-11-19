# Thesis Market

A social trading layer on Gemini Prediction Markets: every paper bet is published with a thesis. Built for the UBC 2026 hackathon. Fills use simulated dollars at Gemini's live prices; optional copy-trade tips use Arc testnet USDC.

**Status on `avi/ubc-hack`: Phase 5 records and account controls are implemented locally.** Public rankings, author profiles, private account history, editable paper caps, escrow activity, disagreement bars and a how-it-works page are connected. All 242 tests, workspace typechecks and the production build passed. Headless desktop/mobile checks exercised real guest limit changes, private receipt visibility and error recovery. See [the Phase 5 handoff](docs/phase-5-records-and-polish.md) for evidence and outstanding human/demo acceptance items. [Phase 4](docs/phase-4-escrow-copy-trading.md) records the verified Arc contract and live refund. Hosted acceptance, a live correct-author payout and news execution remain pending.

### Gemini, the trading agent, and Circle

See [agent types and current implementation status](docs/agents.md) for the BTC strategy, supporting components, planned AI agents, and remaining verification.

The second agent has a [Grok-powered log-only news research pipeline](docs/news-agent.md) for daily BTC/ETH and non-crypto markets. Grok 4.7 performs web research and returns structured forecasts; code validates citation provenance and computes hypothetical entries. A live cited forecast is verified. `NEWS_AGENT_ENABLED=false` remains the default; configure `LLM_PROVIDER=xai`, `LLM_MODEL=grok-4.7`, and server-only `XAI_API_KEY` to use the adapter.

Gemini provides prediction market data and official outcomes. The BTC agent makes its entry decisions with the deterministic momentum model and simulates fills in Postgres. Circle-managed wallets fund optional Arc testnet tips; the separate escrow worker registers theses, verifies deposits and processes payouts/refunds. Circle USDC is separate from the simulated paper bankroll.

Grok is integrated for news research and thesis auditing. A separate publication worker audits guest submissions before on-chain registration, fresh-quote paper execution and publication when escrow is enabled. News execution still needs to be connected to this pipeline.

## Layout

```
apps/web/          Markets, feeds, thesis details/editor, activity and API routes
apps/worker/       Separate BTC, thesis audit/publication and escrow workers
packages/core/     Gemini client and stream schemas, ticker rules, tracked markets, agent limits
packages/services/ Sessions, auditing, publication, paper copies, Circle and escrow outbox
packages/db/       Drizzle schema, migrations, queries
scripts/           Setup, resumable deployment and integration verification
contracts/         Testnet TipEscrow, Foundry tests and public deployment parameters
docs/              gemini-findings.md: what the live APIs actually do
```

`apps/extension/` contains the redesigned read-only prototype from Ashley's branch. Its actual unpacked extension passed headless post-fixture tests; signed-in X validation and live API wiring remain pending. See [the extension design handoff](docs/extension-design-and-post-testing.md). Agent trading is Nikita's separate workstream.

## Setup

Needs Node 22.4 or newer, pnpm 10 (`corepack enable`), and a Postgres database.

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL
pnpm db:migrate               # creates the nineteen application/workflow tables
pnpm dev:worker               # records prices: a poll every 30 seconds and a live stream
pnpm dev:web                  # http://localhost:3000, markets at /markets
```

Other commands:

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit tests, including parsing of recorded Gemini responses and recorder tests on an in-memory Postgres |
| `pnpm typecheck` | Type-checks every package and the scripts |
| `pnpm start:theses` | Separate thesis audit/publication and guest paper-settlement worker; requires configured auditing |
| `pnpm start:escrow` | Separate Circle wallet, registration, tip and official-outcome escrow worker; requires testnet configuration |
| `corepack pnpm --filter @thesis/worker verify:btc` | Checks live BTC REST, index, book sizes and a recent official outcome without submitting orders |
| `corepack pnpm --filter @thesis/worker check:btc-paper` | Reads BTC paper-fill, decision-log and settlement progress; exit 2 means acceptance is still pending |
| `corepack pnpm --filter @thesis/worker observe:news` | Runs one log-only news observation; can make a metered Grok search request when configured, subject to cadence and caps |
| `pnpm verify:gemini` | Checks every "Verify" item in the build plan against the live services. `--write` refreshes `docs/gemini-findings.md` |
| `pnpm verify:gemini --order` | Also places one small order in Gemini's **sandbox**. Needs `GEMINI_SANDBOX_API_KEY` and `GEMINI_SANDBOX_API_SECRET` |
| `pnpm db:generate` | Generates a migration after a schema change |

## Deploy

- **Database:** a Supabase Postgres project. Use the pooled connection string as `DATABASE_URL`.
- **Worker:** Railway, from the repository root. The root `start` script runs the worker, and Railway's builder needs it to find the start command. Set `DATABASE_URL`. The worker applies migrations when it starts.
- **Web:** Vercel, with the root directory set to `apps/web`. Set `DATABASE_URL` and `TRADING_MODE=paper`.

`GET /api/health` on the web app reports how many tracked contracts received price points in the last five minutes.

### Thesis publishing

See [the Phase 3 runbook](docs/phase-3-theses-auditor-feeds.md) for guest signing, the audit worker, limits, screenshots and verification evidence. Local setup uses `node scripts/setup-local-theses.mjs` and `.\scripts\local-worker.ps1 start -Worker theses`; the original BTC supervisor remains independent. Audits use server-only Grok credentials and make bounded metered calls for queued submissions. News scheduling remains disabled.

### Escrow, copy trading and hosted verification

The [Phase 4 handoff](docs/phase-4-escrow-copy-trading.md) covers testnet setup, contract trust, limits, recovery and live receipt evidence. Hosted acceptance remains separate. Run the BTC, thesis and escrow processes independently with the intended shared database before verifying a hosted deployment.

For the currently selected **local** verification database, use `.\scripts\local-worker.ps1 start` and `.\scripts\local-worker.ps1 status` in PowerShell 7. This runs a supervised BTC paper worker with archived logs, heartbeat reporting, and restart-on-exit/stall behavior. Scheduled Grok research stays disabled in this local supervisor. See [the worker runbook](docs/btc-paper-worker.md#managed-local-worker). The helper refuses remote database URLs.

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
