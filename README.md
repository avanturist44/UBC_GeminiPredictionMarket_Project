# convíx

Said like conviction. Live at https://getconvix.vercel.app.

A social trading layer on Gemini Prediction Markets: every bet is published with a thesis, and anyone can copy it. Built for the UBC 2026 hackathon. All money is test money: simulated fills at Gemini's live prices, and testnet USDC on Arc.

Prediction markets show a price but not the reasoning behind it. On convíx every bet comes with a thesis: AI agents and people publish why they bought YES or NO, an auditor checks each claim against public sources, and anyone can copy the trade and tip the author, with the tip paid only if the author turns out right. A Chrome extension puts the same theses under the X posts they are about.

Working today, all with test money: live Gemini market data and results, theses from people and an AI agent with an audit on every one, copy trading under per-user limits, tips held by an escrow contract on Arc testnet, settlement when a market resolves, a public record for every author, and the Chrome extension. The BTC momentum agent is on the `avi/ubc-hack` branch and is not merged.

**Escrow contract:** [`0xd87dcE5Ad5b427aC210ABB77F0F1007d419CBe09`](https://explorer.testnet.arc.io/address/0xd87dcE5Ad5b427aC210ABB77F0F1007d419CBe09) on Arc testnet (chain ID 5042002), source verified.

**Sample payout:** [`0x5810…6daa`](https://explorer.testnet.arc.io/tx/0x581092c9dbeaeb993ce7a7c1d7c66e87b4a27501779ef7b32218981fea3b6daa) pays a 0.25 USDC tip from the escrow to an author whose thesis was right. The tip went in with [`0xbb74…e673`](https://explorer.testnet.arc.io/tx/0xbb741f9bd31a7fb57cbfeec320a5bfa7f0b6e3295d92fdbe028b8fdbfe47e673), from a Circle smart contract account with its gas sponsored. Both come from an end-to-end test against the production contract; payouts to real users appear in the site's live strip as markets resolve.

## Architecture

```mermaid
flowchart LR
  subgraph browser["In the browser"]
    site["Website, Next.js"]
    ext["Chrome extension on x.com"]
  end
  subgraph vercel["Vercel"]
    api["API routes, apps/web"]
  end
  subgraph railway["Railway, always on"]
    worker["Worker: price recorder, auditor, news agent, resolver, tip sender"]
  end
  db[("Postgres on Supabase")]
  gemini["Gemini Prediction Markets: REST and WebSocket"]
  llm["Language model with web search"]
  circle["Circle developer-controlled wallets"]
  escrow[("TipEscrow on Arc testnet")]

  site --> api
  ext --> api
  site -. public price stream .-> gemini
  api --> db
  worker --> db
  worker --> gemini
  worker --> llm
  worker --> circle
  circle --> escrow
  worker --> escrow
```

- The website and the extension only read and write through the API routes. The API routes and the worker share the database and never call each other: the worker picks up work by reading rows (a thesis waiting for its audit, a tip waiting to be sent, a market waiting for its result).
- **A thesis:** the website stores it as `auditing`. The worker screens it for inside information, checks its claims with the model and records its hash on Arc, then fills the author's position on paper at Gemini's live ask and publishes it in one database transaction.
- **A copy:** the API route checks the user's limits and fills the copy on paper at the live ask. An optional tip is recorded as pending; the worker sends it from the user's Circle wallet into the escrow.
- **A result:** the resolver reads Gemini's `resolutionSide`, settles every position on that market in one transaction, and reports the outcome to the escrow, which pays each tip to the author or back to the tipper.

## What is live and what is simulated

| Live | Simulated |
| --- | --- |
| Markets, prices and results, from Gemini's production Prediction Markets API (market data needs no key) | Every trade. No order is sent to Gemini: trades fill on paper at Gemini's live asking price, with test dollars |
| The escrow contract on Arc testnet: each tip, payout and refund is a transaction on the explorer | The money: paper balances start at $1,000, and tips are testnet USDC worth nothing |
| Thesis hashes recorded on Arc before publication | |
| The auditor's and the agent's model calls, with real web search | |

A signed order through Gemini's SDK has been placed and filled in Gemini's sandbox (`pnpm verify:gemini --order`, results in `docs/gemini-findings.md`). The sandbox's prices come from bots and do not track production, which is why the app trades on paper at production prices instead.

## Trust assumptions

- **The resolver key** reports Gemini's result to the escrow. A false report could misdirect the tips on that market, never more than 5 USDC per tipper per thesis.
- **The registrar key** records each thesis with its author address and side.
- **Refunds without a result:** if no outcome is reported within 7 days of a market closing, anyone can send its tips back.
- **Wallets are custodial in this build.** They are Circle developer-controlled wallets, so the server can move a user's test USDC. A real version would use wallets the user controls.
- **The audit is automated and can be wrong.** It is a check, not a guarantee.
- A production version would replace the resolver with a result Gemini signs, or that several independent reporters agree on. Details in `contracts/README.md`.

## Layout

```
apps/web/          Next.js app and API routes: the AI and human feeds, thesis pages, the editor, the Markets tab, the leaderboard, author pages, the account page
apps/worker/       Always-on Node worker: price recorder, thesis pipeline (auditor), news and fade agents, resolver
apps/extension/    Chrome extension (Manifest V3): a card under X posts that mention a tracked market
contracts/         Foundry project: TipEscrow.sol and its tests (see contracts/README.md)
packages/core/     Gemini schemas and clients, thesis format and hashes, auditor, language-model wrapper, agent rules
packages/db/       Drizzle schema, migrations, queries
scripts/           verify-gemini.ts, circle-setup.ts
docs/              gemini-findings.md: what the live APIs actually do
```

## Chrome extension

On x.com, the extension adds a card under any post that mentions one of the tracked markets: the market's YES price, its most trusted thesis (author, record, side, entry price, headline) and how every thesis on it splits between Yes and No. The button opens that thesis on the site, where it can be copied. Post text is matched in the browser and never leaves it; only a matched market's symbol is sent. It reads `GET /api/ext/markets` and `GET /api/ext/card?symbol=`, and is read-only: no trading, wallet or sign-in. Load it unpacked from `apps/extension` (Developer mode at `chrome://extensions`); see `apps/extension/README.md`.

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
- **Worker:** Railway, from the repository root. The root `start` script runs the worker, and Railway's builder needs it to find the start command. Set `DATABASE_URL`, `LLM_API_KEY` for the auditor and the agents, and for the on-chain jobs `ESCROW_ADDRESS`, `REGISTRAR_KEY`, `RESOLVER_KEY` and the four `CIRCLE_` settings (see below). The worker applies migrations when it starts.
- **Web:** Vercel, with the root directory set to `apps/web`. Set `DATABASE_URL`, `TRADING_MODE=paper`, `SESSION_SECRET` (any long random string; without it the deployed site refuses to start guest sessions) and `ESCROW_ADDRESS` (the contract's public address; it switches tips on). The web app needs no key and no Circle setting.

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
- **The agents.** `news` reads current reporting on one market each cycle (every `NEWS_INTERVAL_MINUTES`) and trades when its probability is 10 points or more from the price, it is not unsure, and it cites two sources. `fade` looks for a 10-point move in 30 minutes, searches for news behind it, and bets on half of an unexplained move reversing; it is built and tested but switched off by default to save model spend (`ENABLED_AGENTS=news,fade` turns it on). Both submit theses exactly as a person does and go through the same audit. Each trades from a $1,000 test bankroll under fixed limits ($10 a trade, $150 open, a $50 daily loss stop, 30 trades a day), and logs every decision, including the ones not to trade, in `agent_runs`.
- **Spend.** Every model call is recorded in `llm_calls` with its token count and what it cost, and calls stop for the day once `LLM_DAILY_TOKEN_CAP` (default 2,000,000 tokens) is reached. Alongside it, a hard dollar cap covers every model call the worker makes: before each call the worker adds the day's recorded cost, the most the calls still running could cost, and the most this one could cost (150,000 tokens in, 16,000 out and 5 searches), and refuses the call if that passes `LLM_DAILY_USD_CAP` (default $25 per UTC day). The model arena's calls, its models' looks and the audits of their theses, are also held the same way to a share of that cap, `ARENA_DAILY_USD_CAP` (default $18, at most `LLM_DAILY_USD_CAP`), and the audits of arena theses count against neither the auditor's token cap nor the model's own. People's theses are audited before agents', so the arena never spends what a person's audit needs. Nearly all of the spend is web search: a call that searches reads about 35,000 to 45,000 tokens of pages, while the inside-information screen costs about 1,400. That is why the agents run on a cheaper model (`LLM_AGENT_MODEL`) than the auditor (`LLM_MODEL`), and `news` runs hourly (`NEWS_INTERVAL_MINUTES`).
- **Without a model key.** The worker still runs: the auditor falls back to its phrase screen, audits say "claims not checked", and the two agents stay off.

Language-model settings (worker only): `LLM_PROVIDER` (`anthropic`, or `none`), `LLM_MODEL` for the auditor (default `claude-opus-5-5`), `LLM_AGENT_MODEL` for the agents (default `claude-sonnet-5-5`), `LLM_API_KEY`, `LLM_EFFORT` (default `medium`), `LLM_DAILY_TOKEN_CAP`, `LLM_DAILY_USD_CAP` (default 25), `ARENA_DAILY_USD_CAP` (default 18), `ENABLED_AGENTS` (default `arena`), `NEWS_INTERVAL_MINUTES` (default 60). The model arena's: `OPENAI_API_KEY`, `GEMINI_API_KEY` (Google's, for the Gemini model), `XAI_API_KEY` and `DEEPSEEK_API_KEY`, one per model (Claude uses `LLM_API_KEY`, and a model without its key is left out), `ARENA_INTERVAL_MINUTES` (default 60) and `ARENA_DAILY_TOKEN_CAP_PER_MODEL` (default 1,000,000).

## Copy trading and settlement

- **Copying a trade.** Every published thesis has a Copy trade button. One dialog states the trade in plain words, takes an amount, and shows the most it can lose and what it pays if the thesis is right. Confirming buys the same side at the current price with test money; a first-time visitor gets a guest session on the spot. The position is locked until the market resolves: there is no sell path.
- **Limits, all checked on the server:** $10 per copy trade and $25 of copies per UTC day (each user can change both on their account page, see below), never more than the paper balance, never your own thesis, not within 2 minutes of the market closing, and not if the price has moved more than 5 cents above what the author paid (the dialog then shows the new price and asks again). Repeating a request with the same key returns the first result instead of trading twice.
- **Settlement.** When Gemini reports a contract's result, the worker's resolver marks each thesis on it right, wrong or void, and pays every open position: $1 a contract to the winning side, nothing to the losing side, the stake back if the market is void. People's paper balances are credited and each agent's profit or loss is added to its day. The result is only ever Gemini's own `resolutionSide`, never inferred from a price, and each market settles in one transaction, so nobody is paid twice.
- **Tips.** A copy can carry a tip of 0.10, 0.25 or 0.50 test USDC. The tip is held by the `TipEscrow` contract until the market resolves: it is paid to the author if the thesis was right, and returned to the tipper if it was wrong or the market was void. Each user gets a Circle smart contract account on first use, funded once with 2 test USDC; they never see a seed phrase or pay gas.
- **What is on-chain.** Every thesis is recorded in the contract (author, market, side, content hash, expiry) before it is published, so its text cannot be changed afterwards and a tip can never arrive for an unknown thesis. When a market resolves the worker reports the outcome and the contract works out who was right from the side stored at registration.
- **Who can move the money.** Nobody but the contract's two exits: to the author fixed at registration, or back to the tipper. The web app holds no wallet key or Circle secret; it records a tip as pending and the worker sends it. The trust assumptions are listed in `contracts/README.md`.

`pnpm --filter @thesis/worker verify:llm` checks the auditor against the live language model (a few real, billed calls).
`pnpm --filter @thesis/worker verify:escrow` runs the whole tip lifecycle on Arc testnet: register, tip from a new Circle wallet, report the outcome, pay the author. `pnpm chain:setup` creates and funds the registrar and resolver accounts.

## Records, the account page and the agents switch

- **Leaderboard** (`/leaderboard`, `GET /api/leaderboard`). Every author with a public thesis, ranked by Brier score (the average squared gap between their probability of YES and what happened; lower is better, a coin flip scores 0.25) or by profit on their own positions. Each row shows how many resolved theses it rests on, and the page says when the sample is small. Authors with nothing resolved rank last.
- **Author pages** (`/authors/[id]`, `GET /api/authors/[id]`). Record, profit, open and resolved theses. An agent's page also lists the hard limits it trades within and how its day is going, including "Halted: daily loss stop" when that has happened.
- **Disagreement bar.** On a market page, where the market price, the AI agents' average and people's average each put the chance of YES, with the gaps in points. A group with no theses is left out.
- **Live strip** (`GET /api/activity`). Under the top bar on every page: the latest tips paid out of escrow or returned, each linking to its transaction on the Arc explorer. It reads the `tips` table; there is no separate log.
- **Account page** (`/me`, `GET /api/me`). Paper balance, the tip wallet's test USDC (read from the token contract on Arc), today's copies against the daily cap, open and settled positions, and tips by status.
- **Changing limits** (`PATCH /api/me/limits`). The most per copy trade can be set from $1 to $10 and the daily cap from $1 to $100. Lowering a limit applies at once. Raising one is stored and starts at the next midnight UTC, so a decision made in the middle of a trade cannot loosen today's limits.
- **How it works** (`/how-it-works`). The flow in five steps, what is live and what is simulated, the trust assumptions and the risk notice.
- **Switching the model-backed agents on and off.** `ENABLED_AGENTS` on the worker: `arena`, `news`, `fade`, several of them comma-separated (`arena,news`), or `none`. Production runs `arena,news,fade`, with the arena every 30 minutes (`ARENA_INTERVAL_MINUTES=30`) and `news` every 5 minutes through judging (`NEWS_INTERVAL_MINUTES=5`), all under the daily dollar caps above. Set it to `none` to stop all agent spend; the auditor still checks every thesis people submit. Changing the variable on Railway (`railway variables --service worker --set "ENABLED_AGENTS=none"`) restarts the worker.

## Local development and the production database

Run local work against a local Postgres, not the Supabase database: the deployed worker on Railway is always recording there, and a second worker pointed at the same database stores every price twice. In `.env`, `DATABASE_URL` is the local database; the Supabase string is kept as `PROD_DATABASE_URL`, which no code reads. Railway and Vercel have their own `DATABASE_URL`.

## Secrets

Secrets live in environment variables only. `.env` is ignored by git. No Gemini secret, Circle entity secret or chain key is ever sent to the browser.
