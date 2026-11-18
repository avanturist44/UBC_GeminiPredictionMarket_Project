# Thesis Market

A social trading layer on Gemini Prediction Markets: every bet is published with a thesis, and anyone can copy it. Built for the UBC 2026 hackathon. All money is test money: simulated fills at Gemini's live prices, and testnet USDC on Arc.

**Status: Phase 3 (theses, the auditor and the feeds), with live market data from Phase 1.** People and two AI agents publish theses; every thesis is audited before it goes up; its author's position is filled with test money and locked. The BTC momentum agent and paper settlement (Phase 2) are on the `avi/ubc-hack` branch. The escrow, tips and copy trade come in Phase 4. The full README (architecture, trust assumptions, what is simulated) is written in Phase 7.

## Layout

```
apps/web/          Next.js app and API routes: the AI and human feeds, thesis pages, the editor, the Markets tab
apps/worker/       Always-on Node worker: price recorder, thesis pipeline (auditor), news and fade agents
packages/core/     Gemini schemas and clients, thesis format and hashes, auditor, language-model wrapper, agent rules
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
- **Worker:** Railway, from the repository root. The root `start` script runs the worker, and Railway's builder needs it to find the start command. Set `DATABASE_URL`, and `LLM_API_KEY` for the auditor and the agents (see below). The worker applies migrations when it starts.
- **Web:** Vercel, with the root directory set to `apps/web`. Set `DATABASE_URL`, `TRADING_MODE=paper` and `SESSION_SECRET` (any long random string; without it the deployed site refuses to start guest sessions).

`GET /api/health` on the web app reports how many tracked contracts received price points in the last five minutes.

## How prices are recorded and shown

- The worker polls each tracked event every 30 seconds (`source = rest`) and holds one WebSocket to Gemini with a `bookTicker` subscription per tracked contract (`source = ws`, at most one row per contract every 10 seconds, and none while the quote is unchanged).
- If the socket drops or goes silent, the worker reconnects after 1, 2, 4 and up to 30 seconds and subscribes again. The poll keeps recording in the meantime.
- Gemini's API returns no price history, so each chart starts when recording started.
- A market's current quote is stored as soon as the stream reports a change (within about a second), separately from the 10-second price points, so the prices on a page are not held back by the chart's resolution.
- The Markets tab shows what Gemini's own site shows: the price to buy YES and the price to buy NO. The chart line is the midpoint of the YES bid and ask, and it ends at the current quote.
- A 15-minute or 5-minute crypto contract is charted from the moment its window opens, as on Gemini's site. Before that it has no strike and its quotes sit near 50 cents.
- On the Markets pages the browser also holds its own connection to Gemini's public price stream (no key, market data only) and shows those quotes as they arrive, so the prices match Gemini's site to the second. This is the one place the browser talks to Gemini directly; trading, and everything that needs a key, stays on the server. If that connection drops, the page says so and shows the prices from our API until it reconnects.
- Pages re-read their data from our API every 2 seconds, so the chart, the thesis counts and the fallback prices update without a reload. Measured locally, the API is under a second behind Gemini's live feed, so a page is at most about 3 seconds behind. On the 15-minute contracts the odds move several cents a second, so two screens read a few seconds apart will still differ by a few cents.

## Theses, the auditor and the agents

- **Writing a thesis.** Anyone can write one at `/write` with no account: a guest session gives them $1,000 of test money. A thesis names a market, a side, the author's probability, a stake of $1 to $10, a headline (90 characters), a body (1,200) and at least one source. The side must follow from the probability at the current price, there is one thesis per author per market, and it cannot be edited afterwards.
- **What happens on submit.** The web app checks the thesis and stores it as `auditing`, with the author's intended position as a `pending` trade. Nothing is charged yet. The worker audits it, then either blocks it, or fills the position at the live price and publishes, in one database transaction. If the price has moved more than 5 cents past what the author saw, or past their own probability, the thesis goes back to draft and nothing is charged.
- **The auditor.** A phrase list and a language model screen for claims of inside or non-public knowledge and for prohibited content; either blocks the thesis. The model then lists up to six factual claims. Claims about the market's own price or strike are checked in code; the rest are checked by the model with web search. Any claim found unsupported or contradicted flags the thesis: it is still published, with every claim and its source shown.
- **What the model can and cannot do.** Its only tool is web search. Its output is always parsed against a schema. Text from theses and web pages is passed to it as data, with an instruction to ignore any instructions inside. It never chooses a side, size, price or account: those come from numbers the author or agent committed to before the audit.
- **The agents.** `news` reads current reporting on one market every 15 minutes and trades when its probability is 10 points or more from the price, it is not unsure, and it cites two sources. `fade` looks every 5 minutes for a 10-point move in 30 minutes, searches for news behind it, and bets on half of an unexplained move reversing. Both submit theses exactly as a person does and go through the same audit. Each trades from a $1,000 test bankroll under fixed limits ($10 a trade, $150 open, a $50 daily loss stop, 30 trades a day), and logs every decision, including the ones not to trade, in `agent_runs`.
- **Spend.** Every model call is recorded in `llm_calls` with its token count, and calls stop for the day once `LLM_DAILY_TOKEN_CAP` (default 2,000,000 tokens) is reached.
- **Without a model key.** The worker still runs: the auditor falls back to its phrase screen, audits say "claims not checked", and the two agents stay off.

Language-model settings (worker only): `LLM_PROVIDER` (`anthropic`, or `none`), `LLM_MODEL` (default `claude-opus-5-5`), `LLM_API_KEY`, `LLM_EFFORT` (default `medium`), `LLM_DAILY_TOKEN_CAP`. Positions opened here are not settled yet: paying out when a market resolves arrives with the resolver.

## Local development and the production database

Run local work against a local Postgres, not the Supabase database: the deployed worker on Railway is always recording there, and a second worker pointed at the same database stores every price twice. In `.env`, `DATABASE_URL` is the local database; the Supabase string is kept as `PROD_DATABASE_URL`, which no code reads. Railway and Vercel have their own `DATABASE_URL`.

## Secrets

Secrets live in environment variables only. `.env` is ignored by git. No Gemini secret, Circle entity secret or chain key is ever sent to the browser.
