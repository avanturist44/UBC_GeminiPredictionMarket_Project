# Gemini thesis-trading app: build plan and architecture

Nov 16, 2026 · @Pretender

## How to use this document

This is the build specification for a web app and a Chrome extension on Gemini Prediction Markets, due Friday, November 20, 2026 at 10:00 AM Pacific (12:00 PM Central). The working name is `thesis-market`; rename freely.

Instructions for an AI coding model:

1. Build in the order given in "Build phases and schedule". Do not start a phase until the previous phase meets its acceptance criteria.
2. Ignore the days and times in that section. They are planning notes for the human team. Work through the phases as fast as you can, and move on as soon as a phase's "Done when" column is met. The only real deadline is the submission time above.
3. At the end of each phase, stop and report: what was built, which acceptance criteria were checked and how, and what needs a person (an account, a key, a decision).
4. Treat "Gemini Prediction Markets API" as the only source of truth for Gemini endpoints and fields. Do not invent endpoints, fields or enum values. If something needed is not listed, read developer.gemini.com before writing code.
5. Items marked **Verify** were not confirmed from documentation. Write a small script that checks each one against the live API before any code depends on it.
6. All money in this build is test money: Gemini's sandbox or simulated fills, and testnet USDC. Never add a real-money code path.
7. Keep secrets in environment variables. Never commit keys, and never send a Gemini secret, Circle entity secret or resolver key to the browser or the extension.

Scope:

- **In:** a responsive website with three tabs (AI feed, Human feed, Markets), three AI trading agents that publish a thesis with every trade, copy trade, an on-chain tip escrow that pays authors only when they are right, an AI auditor for thesis claims, a leaderboard, and user safety limits.
- **Stretch, built last:** a Chrome extension that shows matching theses on X posts, and a QuickNode Stream that drives the live feed from escrow events.
- **Out:** native mobile apps, real-money trading, pooled funds, any market or betting pool run by this app, auto-posting to social platforms, SEO work beyond public pages with clean URLs.

Cut line: if time runs short, cut in this order: Gemini OAuth connect, QuickNode Stream, Chrome extension, the `fade` agent, the AI-versus-human disagreement view, thesis editor polish. Never cut the copy-trade flow, the escrow payout, the auditor, the limits or the README.

## Product summary

The app is a social trading layer on Gemini Prediction Markets: every bet is published with a thesis, and anyone can copy it.

The three tabs:

- **AI feed (home):** three AI agents trade Gemini markets, each with a different strategy and hard limits. Every trade is posted with a thesis.
- **Human feed:** people publish theses in the same format.
- **Markets:** a list of tracked markets with current odds and a count of theses on each side. Each market page has an odds chart with a marker where each thesis was published, and a view of where the agents, the human authors and the market price disagree.

The copy-trade flow:

1. The user taps "Copy trade" on a thesis.
2. A confirmation shows the most they can lose. A daily copy cap applies.
3. The same yes/no trade is placed in the user's own trading account (Gemini sandbox, or a simulated account in paper mode).
4. A small USDC tip moves from the user's app wallet into an on-chain escrow. The user never handles a seed phrase or gas.
5. When the market resolves, the escrow pays the tip to the author if the thesis was right, or returns it to the user if it was wrong.

What keeps it honest:

- **Locked positions:** an author's own bet is shown and cannot be sold through the app before the market resolves.
- **Pay on outcome:** authors earn only when people copied them and the call was right.
- **Public records:** every author, AI or human, has a visible history and a leaderboard rank by forecast accuracy and profit.
- **AI auditor:** each thesis has its factual claims checked against sources. Unsupported claims are marked, and a thesis that claims inside knowledge is blocked.

Hackathon targets: the Consumer Applications main track, the Best use of Arc chain award, the Gemini Prediction Markets bounty, and the QuickNode Streams bounty if the stretch work lands.

## Key decisions and justification

Each choice below favors what can be built and demonstrated reliably by Friday; do not revisit them mid-build.

| Area | Decision | Why | Trade-off or fallback |
| --- | --- | --- | --- |
| Surface | Responsive website: Next.js (App Router), TypeScript, Tailwind | Deploys instantly, gives judges one link, gives every thesis and market a public URL, and is the target for the extension's button | No app-store presence; acceptable for a hackathon |
| Background work | One always-on Node worker process, separate from the web app | Agents, the price recorder and the resolver must loop every 15 to 60 seconds; serverless cron cannot | One more deploy target |
| Hosting | Web on Vercel, worker on Railway, Postgres on Supabase | Fast setup, free tiers, managed database | Fallback: web and worker both on Railway |
| Database | Postgres with Drizzle ORM | Typed schema an AI model can generate and migrate safely | None |
| Sign-in | Guest session by default (signed cookie plus a display name); "Connect Gemini" is optional | A judge can try copy trade in one click | Guests trade in paper mode only |
| Trading | A `TradingAdapter` interface with two implementations: `paper` and `gemini-sandbox` | Sandbox support for prediction markets is unconfirmed, and production trading needs Gemini to review the OAuth app | Phase 0 decides the default; paper mode always works |
| Market data | Gemini's public events API and public WebSocket, production host | Real markets, real prices and real resolutions with no API key | REST polling if the WebSocket is unstable |
| Tracked markets | An allowlist of 8 to 12 contracts: BTC and ETH 15-minute contracts, daily crypto contracts, and 3 to 5 non-crypto markets that resolve by Thursday | Short contracts resolve constantly, so a payout can be shown live; longer ones carry theses worth reading | Theses on 15-minute contracts will be thin; say so in the pitch |
| Chain | Arc testnet (chain ID 5042002) | EVM, so the escrow is plain Solidity tested with Foundry; USDC is the gas token; Circle wallets and QuickNode Streams both support it; the Arc award rewards exactly this stack | The Solana award is larger ($1,500 against $1,000) but a Solana program adds more build risk in the time left |
| User wallets | Circle developer-controlled wallets, one smart contract account per user | No seed phrase and no gas for the user; the server executes the tip after the user confirms | Custodial; disclose it. Production would use user-controlled wallets |
| Escrow | A custom Solidity contract, about 120 lines | Tips pool per thesis and one resolve call pays the author | Considered the ERC-8183 job contract already on Arc; its per-job lifecycle is heavier for many small tips |
| Outcome reporting | A server key reports Gemini's `resolutionSide` to the escrow | Simplest path that works by Friday | Trust assumption; disclose it. Anyone can trigger refunds if a thesis is unresolved 7 days after expiry |
| LLM | One provider-agnostic wrapper returning validated JSON; a web search tool for agents and the auditor | Agents and the auditor need current sources; JSON keeps output machine-checkable | Model and provider set by environment variables |
| Gemini client | Gemini's official TypeScript SDK on the server for signed calls; plain `fetch` for public data | The SDK validates orders locally and handles the terms check | **Verify** the npm package name |
| Live updates | Client polling every 5 seconds in the core build | Simple and enough for a demo | Replaced by the QuickNode Stream webhook in the stretch phase |

## Gemini Prediction Markets API

Market data is public and needs no key; trading needs an API key or an OAuth token. Everything below was read from Gemini's developer documentation on November 16, 2026.

### Hosts

| Environment | REST | WebSocket | Website |
| --- | --- | --- | --- |
| Production | `https://api.gemini.com` | `wss://ws.gemini.com` | `https://exchange.gemini.com` |
| Sandbox | `https://api.sandbox.gemini.com` | `wss://ws.sandbox.gemini.com` per the sandbox guide; another docs page gives `wss://api.sandbox.gemini.com`. **Verify** by connecting | `https://exchange.sandbox.gemini.com` |

Sandbox facts ([sandbox guide](https://developer.gemini.com/get-started/sandbox)): it needs a separate account, new accounts are credited with $100,000 of test USD, and bots simulate order-book activity. For automated login, send the header or cookie `GEMINI-SANDBOX-2FA=true` and use `9999999` as the 2FA code. **Verify:** the guide does not say whether prediction market events exist in the sandbox or whether their symbols match production.

### Identifiers

- **Event ticker:** one event, for example `BTC05M2606011000`.
- **Contract ticker:** one proposition inside an event, for example `UP`.
- **`instrumentSymbol`:** the tradable symbol, `GEMI-{event}-{contract}`, for example `GEMI-BTC05M2606011000-UP`. Use it exactly as returned for orders and streams.

### Public REST endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /v1/prediction-markets/events` | List events. Params: `status`, `category`, `search` (title text), `limit` (1 to 500, default 50), `offset` |
| `GET /v1/prediction-markets/events/{eventTicker}` | One event with its contracts |
| `GET /v1/prediction-markets/events/{eventTicker}/strike` | Strike for an event |
| `GET /v1/prediction-markets/events/recently-settled` | Events settled in the last 24 hours |
| `GET /v1/prediction-markets/events/newly-listed` | Events created in the last 24 hours |
| `GET /v1/prediction-markets/events/upcoming` | Approved events not yet active |
| `GET /v1/prediction-markets/categories` | Category names |

`status` values: `approved`, `active`, `closed`, `under_review`, `settled`, `invalid`. The list response is `{ data: Event[], pagination: { limit, offset, total } }` ([markets schema](https://developer.gemini.com/prediction-markets-spec/markets)).

Event fields used by this app: `ticker`, `title`, `slug`, `description`, `category`, `type` (`binary` or `categorical`), `status`, `expiryDate`, `resolvedAt`, `volume`, `sourceDetails`, `contracts`, `contractOrderbooks` (bids and asks of `{ side, price, quantity }`).

Contract fields used by this app: `instrumentSymbol`, `ticker`, `label`, `status`, `marketState` (`open` or `closed` in examples), `expiryDate`, `prices` (`buy.yes`, `buy.no`, `sell.yes`, `sell.no`, `bestBid`, `bestAsk`, `lastTradePrice`), `priceHistory` (items of `timestamp` and `price`, may be null), `resolutionSide` (`yes`, `no` or null), `resolvedAt`, `strike`, `quantityIncrement`, `quantityMinimum`, `priceIncrement`, `priceMinimum`.

There is no documented candles or trades REST endpoint for prediction markets. Record prices yourself (see the price recorder).

### Short crypto contracts

Crypto events come in 5-minute (`05M`) and 15-minute (`15M`) windows with a single `UP` contract. An `UP` contract resolves YES if the price at expiry is at or above the strike. The strike is the price at the start of the window; it is not in the ticker, and is returned in the event response and by the strike endpoint once captured. The supported underlyings are BTC, ETH, SOL and XRP, but the documentation's short-window examples are all BTC, so **verify** with the events list which assets have 15-minute events. Daily and longer contracts use `HI{PRICE}` with the strike in the ticker, where `D` marks the decimal point. Expiry in the ticker is `YYMMDDHHmm` in UTC ([crypto tickers](https://developer.gemini.com/prediction-markets/tickers-crypto)).

### Settlement

The winning side pays $1.00 per contract and the losing side pays $0.00. Detect resolution by polling the event until the contract's `resolutionSide` is set, or by listing `recently-settled`.

### Authenticated REST endpoints

| Method and path | Purpose | OAuth scope |
| --- | --- | --- |
| `GET /v1/prediction-markets/terms/status` | Has the account accepted the latest terms | `orders:read` |
| `POST /v1/prediction-markets/terms/accept` | Accept the terms | `orders:create` |
| `POST /v1/prediction-markets/order` | Place an order | `orders:create` |
| `POST /v1/prediction-markets/order/cancel` | Cancel an order | `orders:create` |
| `POST /v1/prediction-markets/order/batch` | Place up to 20 orders | `orders:create` |
| `POST /v1/prediction-markets/orders/active` | Open orders | `orders:read` |
| `POST /v1/prediction-markets/orders/history` | Past orders | `orders:read` |
| `POST /v1/prediction-markets/positions` | Open positions | `orders:read` |
| `POST /v1/prediction-markets/positions/settled` | Settled positions | `orders:read` |

API keys need the Trader role. Before the first order, check terms status; if not accepted, show the terms to the user, call accept, then retry.

Order body for REST, as validated by the SDK ([order management reference](https://developer.gemini.com/tools/typescript-sdk/reference/predictions/order-management.md)):

```json
{
  "symbol": "GEMI-FEDJAN26-DN25",
  "orderType": "limit",
  "side": "buy",
  "quantity": "10",
  "price": "0.65",
  "outcome": "yes",
  "timeInForce": "immediate-or-cancel",
  "makerOrCancel": false
}
```

- `orderType`: `limit` or `stop-limit` (`stopPrice` required for stop-limit).
- `side`: `buy` or `sell`. `outcome`: `yes` or `no`.
- `price` and `quantity` are decimal strings, never numbers. `price` is between 0 and 1.
- `timeInForce`: `good-til-cancel`, `immediate-or-cancel` or `fill-or-kill`.
- The response includes `orderId` (a bigint in the SDK), `status` and `symbol`.
- REST and WebSocket order payloads use different field names and are not interchangeable. This app uses REST only.
- **Verify:** for `outcome: "no"`, confirm whether `price` is the NO price, and confirm fees, which the pages read do not list.

### Authentication

- **API key (HMAC):** headers `X-GEMINI-APIKEY`, `X-GEMINI-PAYLOAD` (base64 JSON) and `X-GEMINI-SIGNATURE` (HMAC-SHA384). Use the SDK instead of hand-rolling signatures.
- **OAuth 2.0** ([OAuth guide](https://developer.gemini.com/authentication/oauth.md)): authorization code grant with refresh tokens.
  - Authorize: `GET https://exchange.gemini.com/auth` with `client_id`, `response_type=code`, `redirect_uri`, `state`, `scope` (comma-separated).
  - Token: `POST https://exchange.gemini.com/auth/token` with `grant_type=authorization_code`. The response has `access_token`, `refresh_token`, `scope`, `expires_in`.
  - Access tokens last about 24 hours. Refresh tokens are single-use; store the new one after every refresh.
  - Call the API with `Authorization: Bearer <token>` plus `X-GEMINI-PAYLOAD`. OAuth payloads need no nonce.
  - Use a confidential client (server-side, with `client_secret`). Request only `orders:create` and `orders:read`.
  - Gemini reviews an OAuth app before it is active in production. Sandbox apps can be registered immediately at `https://exchange.sandbox.gemini.com/settings/api`.
  - **Verify:** the sandbox authorize and token URLs are not documented; try the same paths on `exchange.sandbox.gemini.com`.

### WebSocket streams

Public, no auth ([streams reference](https://developer.gemini.com/prediction-markets/websocket/streams)): `{symbol}@bookTicker` (best bid `b` and ask `a` with sizes), `{symbol}@trade`, `{symbol}@depth5`, `contractStatus`. Subscribe with `{ "id": "1", "method": "SUBSCRIBE", "params": ["<stream>"] }`.

Authenticated streams (`orders@account`, `positions@account`) need headers on the handshake, which browsers cannot set, so they are server-only. This app does not need them in the core build.

### Rate limits

Public REST allows 120 requests a minute, and Gemini suggests staying under one a second. Private REST allows 600 a minute. Over the limit returns HTTP 429 ([rate limits](https://developer.gemini.com/rate-limit)).

## System architecture

The system is one web app, one always-on worker and one Postgres database, and only the server side talks to Gemini, Circle and Arc.

&#91;embedded content: system architecture · 2 clients, 3 backend parts, 4 outside services\]

The website and the extension call only the API routes. The API routes and the worker share the database and never call each other directly; the worker picks up work by reading rows.

### Components

| Component | Runs on | Responsibility | Calls |
| --- | --- | --- | --- |
| Website | Vercel (Next.js) | All pages, the copy-trade dialog, the thesis editor | API routes |
| API routes | Vercel (Next.js route handlers) | Read endpoints for feeds and markets; write endpoints for theses, copy trades and limits; Gemini OAuth callback; QuickNode webhook | Postgres, Gemini, Circle |
| Worker | Railway (Node, one process) | Price recorder, three agents, auditor queue, resolver, score updates | Postgres, Gemini, LLM, Circle, Arc RPC |
| Database | Supabase Postgres | The single source of truth for app state | None |
| TipEscrow contract | Arc testnet | Holds tips per thesis; pays the author or refunds tippers once the market outcome is reported | USDC token contract |
| Chrome extension | The user's browser | Matches posts on X to tracked markets and shows a card | API routes (read-only) |

### Repository layout

Use one pnpm workspace so the web app, worker and extension share types.

```
thesis-market/
  apps/web/          Next.js app and API routes
  apps/worker/       Node worker: recorder, agents, auditor, resolver
  apps/extension/    Chrome extension (Manifest V3)
  packages/core/     Shared types, zod schemas, Gemini client, TradingAdapter, limits, scoring
  packages/db/       Drizzle schema, migrations, queries
  contracts/         Foundry project: TipEscrow.sol and tests
  scripts/           verify-gemini.ts, seed.ts, deploy helpers
  README.md          Setup, architecture, trust assumptions
```

### Main data flows

**Price recording.** The worker lists events from Gemini, keeps the allowlisted contracts in `markets`, subscribes to each symbol's `bookTicker` stream, and writes a row to `price_points` at most every 10 seconds per symbol.

**Agent trade.** An agent picks a market, computes a signal, drafts a thesis, sends it to the auditor, re-checks the price, places the order through the `TradingAdapter`, registers the thesis hash on Arc, and publishes the thesis with its position.

**Human thesis.** A person writes a thesis and picks a side and stake. The auditor runs. If it is not blocked, the person's own trade is placed, the hash is registered on Arc, and the thesis is published.

**Copy trade.** The API checks the user's limits and the current price, places the same side for the user, then asks Circle to call `tip` on the escrow from the user's wallet.

**Resolution.** The worker sees `resolutionSide` on a contract, reports the outcome to the escrow, settles each thesis on that market, refunds tippers of wrong theses, settles paper positions, and updates scores.

**Extension card.** The content script matches a post to a tracked market using keyword rules it already downloaded, then fetches one card for that market.

## Data model

Eleven Postgres tables hold all app state; the chain holds only tips, thesis hashes and market outcomes. Use UUID primary keys, `timestamptz` for times, and `numeric` for prices and money (never floats).

| Table | Purpose | Key fields |
| --- | --- | --- |
| `users` | Anyone using the site | `id`, `display_name`, `is_guest`, `trading_mode` (`paper` or `gemini`), `paper_balance_usd` (default 1000), `max_per_trade_usd` (default 10), `daily_copy_cap_usd` (default 25), `circle_wallet_id`, `wallet_address` |
| `gemini_connections` | OAuth tokens for users who connect Gemini | `user_id`, `access_token_enc`, `refresh_token_enc`, `expires_at`, `scope`, `terms_accepted_at` |
| `authors` | Anyone who publishes theses, AI or human | `id`, `kind` (`agent` or `human`), `user_id` (humans), `agent_key` (agents), `display_name`, `strategy_summary`, `wallet_address` |
| `markets` | One row per tracked contract | `id`, `instrument_symbol` (unique), `event_ticker`, `contract_ticker`, `title`, `contract_label`, `category`, `expiry_at`, `status`, `strike`, `yes_bid`, `yes_ask`, `last_price`, `resolution_side`, `resolved_at`, `tracked`, `keywords` (jsonb, for the extension) |
| `price_points` | Odds over time | `market_id`, `ts`, `yes_bid`, `yes_ask`, `last_price`, `source` (`ws`, `rest`, `backfill`); index on (`market_id`, `ts`) |
| `theses` | A published view with a position | `id`, `onchain_id` (bytes32 hex), `author_id`, `market_id`, `side` (`yes` or `no`), `probability_yes` (0 to 1), `headline`, `body` (max 1,200 characters), `evidence` (jsonb list of `{ claim, url }`), `entry_price`, `market_yes_price_at_publish`, `content_hash`, `register_tx`, `status`, `outcome` (`right`, `wrong`, `void`, null), `published_at` |
| `trades` | Every fill, for authors and copiers | `id`, `user_id` or `author_id`, `market_id`, `thesis_id`, `is_author_position`, `side`, `quantity`, `price`, `cost_usd`, `mode` (`paper` or `gemini`), `gemini_order_id`, `status`, `locked`, `payout_usd`, `idempotency_key` (unique) |
| `tips` | One row per tip | `id`, `thesis_id`, `user_id`, `amount_usdc`, `circle_tx_id`, `deposit_tx`, `status` (`pending`, `escrowed`, `paid`, `refunded`, `failed`), `settle_tx` |
| `audits` | Auditor output per thesis | `thesis_id`, `verdict` (`pass`, `flagged`, `blocked`), `claims` (jsonb list of `{ text, status, source_url, note }`), `inside_info`, `model`, `created_at` |
| `agent_runs` | A log of every agent decision | `id`, `agent_key`, `market_id`, `decision` (`trade` or `skip`), `reason`, `signal` (jsonb), `error`, `created_at` |
| `agent_state` | Per-agent, per-day limit tracking | `agent_key`, `day`, `realized_pnl_usd`, `open_exposure_usd`, `trade_count`, `halted`, `halt_reason` |

Thesis `status` values: `draft`, `auditing`, `blocked`, `published`, `resolved`. Claim `status` values: `supported`, `unsupported`, `contradicted`, `unverifiable`.

Relationships: a thesis belongs to one author and one market. A thesis has exactly one author trade (`is_author_position = true`) and any number of copy trades and tips. An audit belongs to one thesis.

Derived values, computed in queries and not stored:

- **Daily copy total:** sum of `cost_usd` for the user's copy trades since midnight UTC.
- **Theses per side:** count of published theses grouped by `market_id` and `side`.
- **Author record:** from resolved theses only. Accuracy is the Brier score, the mean of `(probability_yes - outcome)^2` where `outcome` is 1 if YES won. Lower is better, and a constant 50% forecast scores 0.25. Show the market's own Brier score on the same theses (using `market_yes_price_at_publish`) beside it, so a reader can see whether the author beat the price.
- **Profit:** sum of `payout_usd - cost_usd` over the author's own resolved trades.

On-chain identifiers: `onchain_id = keccak256(thesis uuid)`, market id on-chain = `keccak256(instrument_symbol)`, and `content_hash = keccak256` of the canonical JSON of `{ market, side, probability_yes, headline, body, evidence }`.

## Backend services

The backend is a set of API routes in the web app plus five jobs in the worker, and every rule that protects money is enforced in code on the server, never by an LLM or the browser.

### Shared modules in `packages/core`

**Gemini public client.** A thin `fetch` wrapper for the public endpoints with a token bucket set to one request every 2 seconds, a 10-second timeout, and one retry on 429 or 5xx. Parse every response with a zod schema and log, not crash, on unknown fields.

**TradingAdapter.** All order placement goes through this interface so the rest of the code does not know which mode is active.

```ts
type Outcome = 'yes' | 'no';

interface Quote { bid: string; ask: string; askSize?: string }

interface BuyInput {
  account: { kind: 'agent'; agentKey: string } | { kind: 'user'; userId: string };
  symbol: string;        // instrumentSymbol, verbatim
  outcome: Outcome;
  quantity: string;      // decimal string
  limitPrice: string;    // decimal string, 0 to 1
  idempotencyKey: string;
}

interface Fill {
  status: 'filled' | 'partial' | 'rejected';
  filledQuantity: string;
  avgPrice: string;
  orderId?: string;
  reason?: string;
}

interface TradingAdapter {
  mode: 'paper' | 'gemini-sandbox';
  getQuote(symbol: string, outcome: Outcome): Promise<Quote>;
  buy(input: BuyInput): Promise<Fill>;
}
```

- `PaperAdapter`: reads the latest live price for the symbol, fills at the current ask for that side if `limitPrice` is at or above it, deducts from `paper_balance_usd`, and writes a `trades` row with `mode = 'paper'`. If the order book shows less size at the ask than requested, fill only that size.
- `GeminiSandboxAdapter`: sends `POST /v1/prediction-markets/order` with `orderType: "limit"`, `timeInForce: "immediate-or-cancel"`, `makerOrCancel: false`. Agents use one sandbox API key per agent; users use their OAuth token. It checks terms status before a user's first order.
- There is no sell method. Positions are held to resolution, which is how the position lock is enforced.

**Limits.** One pure function per rule (see "Safety limits"), each returning `{ ok: true }` or `{ ok: false, code, message }`. API routes and agents both call them.

**LLM wrapper.** `generateJson({ system, user, schema, useSearch })` returns an object validated by a zod schema, retries once if validation fails, and times out after 45 seconds. The provider and model come from `LLM_PROVIDER` and `LLM_MODEL`. All text from users, web pages or theses is passed inside clearly marked data blocks, with a system instruction to treat it as data and never as instructions.

### API routes

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /api/feed?kind=agent\|human&cursor=` | None | Published theses, newest first, each with author record, audit summary, entry price and current price |
| `GET /api/markets` | None | Tracked markets with odds, expiry and thesis counts per side |
| `GET /api/markets/[symbol]` | None | Market detail, up to 500 downsampled price points, thesis markers, and the disagreement summary (average AI probability, average human probability, market price) |
| `GET /api/theses/[id]` | None | One thesis with full audit, author position, tips total, on-chain links |
| `GET /api/authors/[id]` | None | Profile, record, all theses |
| `GET /api/leaderboard` | None | Authors ranked by Brier score and by profit, with resolved count |
| `GET /api/activity` | None | Recent payouts and refunds, for the live strip |
| `POST /api/session` | None | Creates a guest user and cookie; queues wallet creation |
| `GET /api/me` | Session | Balances, positions, tips, today's totals, limits |
| `PATCH /api/me/limits` | Session | Lowering a cap applies at once; raising one applies from the next UTC day |
| `POST /api/theses` | Session | Creates a human thesis: validate, audit, place the author's trade, register on-chain, publish |
| `POST /api/theses/[id]/copy` | Session | The copy-trade flow below |
| `GET /api/gemini/connect` | Session | Redirects to Gemini's authorize URL with `state` |
| `GET /api/gemini/callback` | Session | Exchanges the code, stores encrypted tokens, sets `trading_mode = 'gemini'` |
| `GET /api/ext/markets` | None | Tracked markets with keyword rules, for the extension |
| `GET /api/ext/card?symbol=` | None | Odds, top AI thesis, top human thesis for one market |
| `POST /api/webhooks/quicknode` | Shared secret | Stretch: receives escrow events |
| `POST /api/admin/kill-switch` | Admin secret | Turns all trading on or off |

Every write route validates its body with zod, rate-limits by session (10 writes a minute), and returns errors as `{ code, message }`.

### Copy-trade flow: `POST /api/theses/[id]/copy`

Body: `{ amountUsd, tipUsdc, idempotencyKey }`.

1. Load the thesis. Reject unless it is `published`, its market is open, and expiry is more than 2 minutes away.
2. Reject if the user is the author.
3. Run the user limits: per-trade cap, daily cap, tip cap, wallet balance for the tip.
4. Get a fresh quote for the thesis side. If the ask is more than 0.05 above the author's `entry_price`, return `409 price_moved` with the new price so the dialog can ask again.
5. Compute `quantity = floor(amountUsd / ask)` rounded down to `quantityIncrement`. Reject below `quantityMinimum`.
6. Call `adapter.buy` with `limitPrice = ask`. If nothing fills, return `409 no_fill` and take no tip.
7. Insert the `trades` row with `locked = true` and `thesis_id` set.
8. If `tipUsdc > 0`, insert a `tips` row as `pending` and ask Circle to execute `tip(onchain_id, amount)` on the escrow from the user's wallet. Return immediately; the worker confirms the transaction and sets `escrowed` or `failed`.
9. Return the fill, the cost, and the tip status.

The trade and the tip are not atomic by design: a failed tip never undoes a filled trade, and the UI shows the tip state separately. Repeating a request with the same `idempotencyKey` returns the first result.

### User wallets (Circle)

On first session the worker creates one developer-controlled smart contract account on Arc testnet for the user, sends it 2 test USDC from a treasury wallet, and has it approve the escrow for 20 USDC. Circle's SDK is `@circle-fin/developer-controlled-wallets`, and contract calls go through [`POST /v1/w3s/developer/transactions/contractExecution`](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-contract-execution) with a UUID idempotency key. Circle's docs recommend the smart contract account type on Arc testnet because it removes the need for the wallet to hold gas ([Circle Contracts guide](https://developers.circle.com/contracts/deploy-smart-contract-template.md)). **Verify** the exact SDK method names and the Arc testnet blockchain identifier in Circle's quickstart before coding.

Agents and human authors receive payouts at a wallet created the same way. The registrar and resolver are plain keys held by the worker and used with viem, funded from the faucet.

### Gemini OAuth (optional path)

1. `connect` creates a random `state`, stores it in the session, and redirects to the authorize URL with scopes `orders:create,orders:read`.
2. `callback` checks `state`, exchanges the code at the token URL, encrypts both tokens with `TOKEN_ENC_KEY` (AES-256-GCM), and stores them.
3. Before each call, refresh if the access token expires within 5 minutes, and store the new refresh token in the same database transaction, since the old one stops working.
4. Before the first order, call terms status. If not accepted, show Gemini's terms and call accept only after the user clicks to agree.

### Worker job 1: price recorder

- Every 30 seconds: list active events, apply the allowlist rules (explicit tickers, plus "current and next BTC and ETH 15-minute events"), upsert `markets`, and store prices from the response.
- On first sight of a contract: copy its `priceHistory` into `price_points` with `source = 'backfill'`.
- Keep one WebSocket open with a `bookTicker` subscription per tracked symbol; write at most one row per symbol every 10 seconds. Reconnect with backoff, and rely on the 30-second poll while disconnected.
- Start this job on the first day. The chart is only as long as the recording.

### Worker job 2: agents

Each agent runs the same pipeline: pick a market, compute a signal, draft, audit, re-check the price, check limits, trade, register, publish. Every run writes an `agent_runs` row, including skips and the reason.

| Agent | Markets | Cadence | Signal | Trades when |
| --- | --- | --- | --- | --- |
| `momentum` | BTC and ETH 15-minute `UP` contracts | 30 seconds | Probability the index finishes at or above the strike, from distance to strike, time left and volatility over the last 30 minutes: `p = Φ(ln(P/S) / (σ√T))` | Its probability beats the ask by 0.08 or more, 3 to 12 minutes remain, spread is 0.06 or less |
| `news` | Non-crypto markets and daily crypto contracts | 15 minutes, one market per cycle | LLM with web search estimates the probability from the market's title, description and rules, and returns evidence with URLs | Its probability differs from the price by 0.10 or more, confidence is not low, and at least two sources are cited |
| `fade` | Any tracked market with more than 2 hours left | 5 minutes | Finds a move of 0.10 or more in 30 minutes, then asks an LLM with web search whether anything published in the last hour explains it | No explanation is found; it bets on half the move reversing |

- `momentum` takes the index price from the `{agency}:{index}@indexPrice` stream named in the event's `sourceDetails`, and the strike from the strike endpoint. Its thesis text is a template filled with the computed numbers plus one LLM-written sentence, so the numbers cannot be invented.
- LLM agents return `{ probability_yes, confidence, headline, body, evidence: [{ claim, url }], no_trade_reason }`. The side, size and price are decided in code from `probability_yes`, never taken from the LLM.
- Size is $10 per trade by default. An agent holds at most one position per contract and never takes the opposite side of its own open position.

### Worker job 3: auditor

The auditor runs on every thesis before it is published, for agents and humans alike.

1. **Screen:** a keyword check and an LLM check for claims of non-public knowledge (for example "a friend at the company told me", "I work there", "leaked"). A hit sets `inside_info = true` and the verdict `blocked`.
2. **Extract:** the LLM lists up to six checkable factual claims from the thesis. Opinions and predictions are not claims.
3. **Check:** price and market facts are checked in code against the database. Other claims go to an LLM with web search, which returns `supported`, `unsupported`, `contradicted` or `unverifiable` with one source URL and a one-line note.
4. **Verdict:** `blocked` for inside information or prohibited content; `flagged` if any claim is `unsupported` or `contradicted`; otherwise `pass`.

A flagged thesis is still published, with each claim's status shown. A blocked thesis is not published and no trade is placed. The auditor has no tools except search and cannot place trades or change limits.

### Worker job 4: on-chain registrar and tip confirmer

- After a thesis passes audit and its trade fills, call `registerThesis` on the escrow and store `register_tx`. Publish only after the transaction is confirmed, so a tip can never arrive for an unregistered thesis.
- Every 5 seconds, check Circle for the state of `pending` tips and update them.

### Worker job 5: resolver

Every 30 seconds, for each tracked market past expiry with no stored result:

1. Fetch the event. If the contract's `resolutionSide` is still null, stop.
2. Store the result. Call `reportOutcome(marketId, yesWon)` on the escrow, or `reportVoid(marketId)` if the event status is `invalid`.
3. For each thesis on the market, set `outcome`. If the author was right, call `settle(onchain_id)` and mark its tips `paid`. If wrong or void, call `refund(onchain_id, tipper)` for each tipper and mark those tips `refunded`. Store each transaction hash in `settle_tx`.
4. Settle paper trades: `payout_usd = quantity` for winning sides, 0 for losing sides, and credit balances.
5. Update each agent's realized profit for the day in `agent_state`. The live strip needs no table of its own: `GET /api/activity` reads the most recently paid and refunded tips, for example "Momentum was right on BTC 15-minute: 0.60 USDC paid from escrow", with the transaction link.

Every step is idempotent: re-running after a crash must not pay or refund twice. The contract enforces this on-chain; the database uses status checks.

### Environment variables

| Name | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Web, worker | Postgres connection |
| `SESSION_SECRET` | Web | Signs the session cookie |
| `TRADING_MODE` | Web, worker | `paper` or `gemini-sandbox` |
| `TRADING_ENABLED` | Web, worker | Global kill switch |
| `GEMINI_PUBLIC_BASE`, `GEMINI_WS_URL` | Worker | Public data hosts |
| `GEMINI_TRADE_BASE` | Web, worker | Sandbox REST host |
| `GEMINI_AGENT_KEYS` | Worker | JSON of sandbox API key and secret per agent |
| `GEMINI_OAUTH_CLIENT_ID`, `GEMINI_OAUTH_CLIENT_SECRET`, `GEMINI_OAUTH_REDIRECT` | Web | OAuth app |
| `TOKEN_ENC_KEY` | Web, worker | Encrypts stored OAuth tokens |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY` | Worker | Agents and auditor |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_SET_ID`, `CIRCLE_TREASURY_WALLET_ID` | Web, worker | User wallets and tips |
| `ARC_RPC_URL`, `ARC_CHAIN_ID` | Worker | Arc testnet access (`5042002`) |
| `ESCROW_ADDRESS`, `USDC_ADDRESS` | Web, worker | Contract addresses |
| `REGISTRAR_KEY`, `RESOLVER_KEY` | Worker | Keys for the two privileged escrow roles |
| `QUICKNODE_WEBHOOK_SECRET` | Web | Stretch |
| `ADMIN_SECRET` | Web | Kill-switch route |

## Escrow smart contract

`TipEscrow` holds each tip until the market resolves, then pays the author if the thesis was right or returns the tip if it was wrong, and no privileged key can send funds anywhere else.

### Design rules

- **The resolver reports markets, not winners.** It reports one fact per market (YES won, NO won, or void). The contract works out which theses were right from the side stored at registration. The resolver cannot favor one author over another on the same market.
- **Funds have two exits only:** to the author address fixed at registration, or back to the tipper. No owner withdrawal, no fee, no upgrade path.
- **Anyone can trigger settlement and refunds.** The worker does it so users never have to, but nobody depends on the worker to get money back.
- **Timeout:** if a market has no reported outcome 7 days after a thesis's expiry, its tips become refundable.
- **Cap:** one tipper can put at most 5 USDC on one thesis. This bounds what a wrong or dishonest outcome report can cost.
- **Registration before tips:** the registrar records the author, market, side, content hash and expiry before any tip is accepted. The content hash is the on-chain proof of what was claimed and when.

### Network facts

| Item | Value |
| --- | --- |
| Network | Arc testnet, chain ID `5042002` |
| RPC | `https://rpc.testnet.arc.io` ([Arc docs](https://docs.arc.io/integrate/connect-to-arc)); an older docs site lists `https://rpc.testnet.arc.network`. **Verify** with `eth_chainId` and use whichever answers |
| Explorer | `https://explorer.testnet.arc.io` or `https://testnet.arcscan.app` |
| Gas token | USDC. The native balance uses 18 decimals; the ERC-20 interface uses 6 |
| USDC ERC-20 address | `0x3600000000000000000000000000000000000000` ([Arc wallet docs](https://docs.arc.io/integrate/wallets.md)). **Verify** on the explorer |
| Test funds | [faucet.circle.com](https://faucet.circle.com), select Arc Testnet. Circle's blog describes the limit as 10 USDC an hour, so start collecting on day one |

The contract uses only the 6-decimal ERC-20 interface. Never mix the two decimal scales.

### Reference implementation

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract TipEscrow {
    using SafeERC20 for IERC20;

    enum MarketState { Open, YesWon, NoWon, Void }

    struct Thesis {
        address author;
        bytes32 marketId;
        bytes32 contentHash;
        uint64 expiry;
        bool sideYes;
        bool settled;
        uint128 totalTips;
    }

    uint256 public constant MAX_TIP = 5e6; // 5 USDC at 6 decimals
    uint64 public constant TIMEOUT = 7 days;

    IERC20 public immutable usdc;
    address public immutable registrar;
    address public immutable resolver;

    mapping(bytes32 => Thesis) public theses;
    mapping(bytes32 => MarketState) public marketState;
    mapping(bytes32 => mapping(address => uint256)) public tipOf;

    event ThesisRegistered(bytes32 indexed id, address indexed author, bytes32 indexed marketId, bool sideYes, bytes32 contentHash, uint64 expiry);
    event Tipped(bytes32 indexed id, address indexed tipper, uint256 amount);
    event OutcomeReported(bytes32 indexed marketId, MarketState state);
    event AuthorPaid(bytes32 indexed id, address indexed author, uint256 amount);
    event Refunded(bytes32 indexed id, address indexed tipper, uint256 amount);

    constructor(address usdc_, address registrar_, address resolver_) {
        require(usdc_ != address(0) && registrar_ != address(0) && resolver_ != address(0), "zero address");
        usdc = IERC20(usdc_);
        registrar = registrar_;
        resolver = resolver_;
    }

    function registerThesis(bytes32 id, address author, bytes32 marketId, bool sideYes, bytes32 contentHash, uint64 expiry) external {
        require(msg.sender == registrar, "not registrar");
        require(author != address(0), "no author");
        require(theses[id].author == address(0), "exists");
        require(marketState[marketId] == MarketState.Open, "market closed");
        require(expiry > block.timestamp, "expired");
        theses[id] = Thesis(author, marketId, contentHash, expiry, sideYes, false, 0);
        emit ThesisRegistered(id, author, marketId, sideYes, contentHash, expiry);
    }

    function tip(bytes32 id, uint256 amount) external {
        Thesis storage t = theses[id];
        require(t.author != address(0), "unknown thesis");
        require(block.timestamp < t.expiry, "expired");
        require(marketState[t.marketId] == MarketState.Open, "market closed");
        require(amount > 0 && tipOf[id][msg.sender] + amount <= MAX_TIP, "bad amount");
        tipOf[id][msg.sender] += amount;
        t.totalTips += uint128(amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Tipped(id, msg.sender, amount);
    }

    function reportOutcome(bytes32 marketId, bool yesWon) external {
        require(msg.sender == resolver, "not resolver");
        require(marketState[marketId] == MarketState.Open, "already reported");
        marketState[marketId] = yesWon ? MarketState.YesWon : MarketState.NoWon;
        emit OutcomeReported(marketId, marketState[marketId]);
    }

    function reportVoid(bytes32 marketId) external {
        require(msg.sender == resolver, "not resolver");
        require(marketState[marketId] == MarketState.Open, "already reported");
        marketState[marketId] = MarketState.Void;
        emit OutcomeReported(marketId, MarketState.Void);
    }

    // Pays the author when the thesis side matches the reported outcome.
    function settle(bytes32 id) external {
        Thesis storage t = theses[id];
        require(t.author != address(0), "unknown thesis");
        require(!t.settled, "settled");
        MarketState s = marketState[t.marketId];
        require(s == MarketState.YesWon || s == MarketState.NoWon, "no outcome");
        require((s == MarketState.YesWon) == t.sideYes, "author wrong");
        t.settled = true;
        uint256 amount = t.totalTips;
        t.totalTips = 0;
        if (amount > 0) usdc.safeTransfer(t.author, amount);
        emit AuthorPaid(id, t.author, amount);
    }

    // Returns one tipper's tip when the author was wrong, the market is void,
    // or no outcome was reported within TIMEOUT of expiry.
    function refund(bytes32 id, address tipper) external {
        Thesis storage t = theses[id];
        require(t.author != address(0), "unknown thesis");
        MarketState s = marketState[t.marketId];
        bool wrong = (s == MarketState.YesWon && !t.sideYes) || (s == MarketState.NoWon && t.sideYes);
        bool timedOut = s == MarketState.Open && block.timestamp > uint256(t.expiry) + TIMEOUT;
        require(wrong || s == MarketState.Void || timedOut, "not refundable");
        uint256 amount = tipOf[id][tipper];
        require(amount > 0, "nothing to refund");
        tipOf[id][tipper] = 0;
        t.totalTips -= uint128(amount);
        usdc.safeTransfer(tipper, amount);
        emit Refunded(id, tipper, amount);
    }
}
```

This contract was compiled with Solidity 0.8.28 and OpenZeppelin's current contracts, and it passes the test file below under Foundry (8 tests, including a fuzz test). Any change must keep state updates before token transfers and must keep those tests passing.

### Tests (Foundry, with a 6-decimal mock token)

1. Register, two tippers tip, YES reported, `settle` pays the author the exact total.
2. Same setup with the author wrong: `settle` reverts, each `refund` returns the exact tip, a second `refund` reverts.
3. Void market: every tipper is refunded, `settle` reverts.
4. Timeout: no report, time moves past expiry plus 7 days, refunds work. A later outcome report followed by `settle` pays only what was not refunded.
5. Access: only the registrar registers, only the resolver reports, a second report on the same market reverts.
6. Guards: tip on an unknown thesis, after expiry, after a report, of zero, or above the cap all revert. Registering the same id twice reverts.
7. Second `settle` reverts.
8. Fuzz: for random tip amounts and outcomes, the contract's token balance always equals the sum of unsettled tips.

Starting test file, `contracts/test/TipEscrow.t.sol`. It needs the remapping `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/` in `remappings.txt`.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {TipEscrow} from "../src/TipEscrow.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract TipEscrowTest is Test {
    MockUSDC usdc;
    TipEscrow esc;
    address registrar = address(0xA1);
    address resolver = address(0xA2);
    address author = address(0xB1);
    address alice = address(0xC1);
    address bob = address(0xC2);
    bytes32 id = keccak256("t1");
    bytes32 mkt = keccak256("GEMI-X-UP");
    uint64 expiry;

    function setUp() public {
        usdc = new MockUSDC();
        esc = new TipEscrow(address(usdc), registrar, resolver);
        expiry = uint64(block.timestamp + 900);
        for (uint256 i; i < 2; i++) {
            address u = i == 0 ? alice : bob;
            usdc.mint(u, 100e6);
            vm.prank(u);
            usdc.approve(address(esc), type(uint256).max);
        }
        vm.prank(registrar);
        esc.registerThesis(id, author, mkt, true, bytes32("h"), expiry);
    }

    function _tips() internal {
        vm.prank(alice);
        esc.tip(id, 1e6);
        vm.prank(bob);
        esc.tip(id, 250000);
    }

    function test_rightPaysAuthor() public {
        _tips();
        vm.prank(resolver);
        esc.reportOutcome(mkt, true);
        esc.settle(id);
        assertEq(usdc.balanceOf(author), 1250000);
        assertEq(usdc.balanceOf(address(esc)), 0);
        vm.expectRevert(bytes("settled"));
        esc.settle(id);
        vm.expectRevert(bytes("not refundable"));
        esc.refund(id, alice);
    }

    function test_wrongRefunds() public {
        _tips();
        vm.prank(resolver);
        esc.reportOutcome(mkt, false);
        vm.expectRevert(bytes("author wrong"));
        esc.settle(id);
        esc.refund(id, alice);
        esc.refund(id, bob);
        assertEq(usdc.balanceOf(alice), 100e6);
        assertEq(usdc.balanceOf(bob), 100e6);
        assertEq(usdc.balanceOf(address(esc)), 0);
        vm.expectRevert(bytes("nothing to refund"));
        esc.refund(id, alice);
    }

    function test_void() public {
        _tips();
        vm.prank(resolver);
        esc.reportVoid(mkt);
        vm.expectRevert(bytes("no outcome"));
        esc.settle(id);
        esc.refund(id, alice);
        assertEq(usdc.balanceOf(alice), 100e6);
    }

    function test_timeoutThenLateReport() public {
        _tips();
        vm.expectRevert(bytes("not refundable"));
        esc.refund(id, alice);
        vm.warp(uint256(expiry) + 7 days + 1);
        esc.refund(id, alice);
        assertEq(usdc.balanceOf(alice), 100e6);
        vm.prank(resolver);
        esc.reportOutcome(mkt, true);
        esc.settle(id);
        assertEq(usdc.balanceOf(author), 250000);
        assertEq(usdc.balanceOf(address(esc)), 0);
    }

    function test_access() public {
        vm.expectRevert(bytes("not registrar"));
        esc.registerThesis(keccak256("t2"), author, mkt, true, bytes32("h"), expiry);
        vm.expectRevert(bytes("not resolver"));
        esc.reportOutcome(mkt, true);
        vm.expectRevert(bytes("not resolver"));
        esc.reportVoid(mkt);
        vm.startPrank(resolver);
        esc.reportOutcome(mkt, true);
        vm.expectRevert(bytes("already reported"));
        esc.reportOutcome(mkt, false);
        vm.expectRevert(bytes("already reported"));
        esc.reportVoid(mkt);
        vm.stopPrank();
    }

    function test_guards() public {
        vm.startPrank(alice);
        vm.expectRevert(bytes("unknown thesis"));
        esc.tip(keccak256("nope"), 1e6);
        vm.expectRevert(bytes("bad amount"));
        esc.tip(id, 0);
        vm.expectRevert(bytes("bad amount"));
        esc.tip(id, 5e6 + 1);
        esc.tip(id, 5e6);
        vm.expectRevert(bytes("bad amount"));
        esc.tip(id, 1);
        vm.stopPrank();
        vm.prank(registrar);
        vm.expectRevert(bytes("exists"));
        esc.registerThesis(id, author, mkt, true, bytes32("h"), expiry);
        vm.warp(expiry);
        vm.prank(bob);
        vm.expectRevert(bytes("expired"));
        esc.tip(id, 1e6);
    }

    function test_noTipAfterReport() public {
        vm.prank(resolver);
        esc.reportOutcome(mkt, true);
        vm.prank(alice);
        vm.expectRevert(bytes("market closed"));
        esc.tip(id, 1e6);
        vm.prank(registrar);
        vm.expectRevert(bytes("market closed"));
        esc.registerThesis(keccak256("t3"), author, mkt, true, bytes32("h"), expiry);
    }

    function testFuzz_balanceMatches(uint256 a, uint256 b, bool yesWon, bool refundAliceFirst) public {
        a = bound(a, 1, 5e6);
        b = bound(b, 1, 5e6);
        vm.prank(alice);
        esc.tip(id, a);
        vm.prank(bob);
        esc.tip(id, b);
        assertEq(usdc.balanceOf(address(esc)), a + b);
        vm.prank(resolver);
        esc.reportOutcome(mkt, yesWon);
        if (yesWon) {
            esc.settle(id);
            assertEq(usdc.balanceOf(author), a + b);
        } else {
            if (refundAliceFirst) {
                esc.refund(id, alice);
                assertEq(usdc.balanceOf(address(esc)), b);
                esc.refund(id, bob);
            } else {
                esc.refund(id, bob);
                esc.refund(id, alice);
            }
            assertEq(usdc.balanceOf(author), 0);
        }
        assertEq(usdc.balanceOf(address(esc)), 0);
    }
}
```

### Deployment

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts
forge test -vv
forge create src/TipEscrow.sol:TipEscrow \
  --rpc-url $ARC_RPC_URL --private-key $DEPLOYER_KEY --broadcast \
  --constructor-args $USDC_ADDRESS $REGISTRAR_ADDRESS $RESOLVER_ADDRESS
```

After deploying: verify the source on the explorer, put the address in `ESCROW_ADDRESS`, export the ABI to `packages/core`, and run a script that registers a test thesis, tips it, reports an outcome and settles it. Link the contract and that settlement transaction in the README.

### Trust assumptions to state in the README

- The resolver key is trusted to report Gemini's result honestly. A false report can misdirect at most the tips on that market, never more than 5 USDC per tipper per thesis.
- The registrar key is trusted to record the correct author address and side.
- User wallets are custodial in this build: the server can move a user's test USDC.
- A production version would replace the resolver with a result that Gemini signs or that several independent reporters agree on, and would use wallets the user controls.

## Web frontend

The website has ten pages, is designed for a phone-width screen first, and must let a first-time visitor copy a trade within one minute without creating an account.

### Global layout

- A top bar with the product name, a "Simulated funds" badge that is always visible, and the user's paper balance and tip balance.
- Three primary tabs: **AI**, **Humans**, **Markets**. On phones they sit in a bottom bar.
- Secondary links: Leaderboard, Write a thesis, Me, How it works.
- A live strip under the top bar showing the latest payouts and refunds, each linking to its transaction on the Arc explorer.
- Server-render all public pages so they load fast and have shareable URLs. Fetch live data on the client with SWR, refreshing every 5 seconds.

### Pages

| Route | Purpose | Main elements |
| --- | --- | --- |
| `/` | AI feed (home) | Thesis cards from agents, newest first; filter by agent |
| `/humans` | Human feed | Thesis cards from people; "Write a thesis" button |
| `/markets` | Market list | Rows with title, YES price, time to expiry, count of theses for YES and for NO; sort by expiry or thesis count |
| `/markets/[symbol]` | Market detail | Odds chart with thesis markers, disagreement bar, theses split into YES and NO columns, link to the market on Gemini |
| `/thesis/[id]` | One thesis | Full text, evidence links, audit result per claim, author position, tips in escrow, content hash and registration transaction, Copy trade button |
| `/authors/[id]` | Author profile | Strategy summary (agents) or bio, record, resolved and open theses, limits for agents |
| `/leaderboard` | Rankings | Table of authors by Brier score and by profit, with resolved count and an "early sample" note |
| `/write` | Thesis editor | Market picker, side, probability slider, stake, headline, body, evidence rows, live preview |
| `/me` | The user's account | Open and settled positions, tips by status, today's totals against caps, limit settings, Connect Gemini |
| `/how-it-works` | Explanation | The flow in five steps, what is simulated, trust assumptions, risk notice |

### Key components

**ThesisCard.** Shows author name with an AI or Human tag, the author's record ("7 of 11 right, Brier 0.19"), market title, side as a YES or NO pill, the author's probability, entry price against current price, the headline, two lines of body, an audit badge (Checked, Flagged, with a count of unsupported claims), tips in escrow, time to expiry, and the Copy trade button. After resolution it shows Right or Wrong and what was paid or refunded.

**CopyTradeDialog.** One screen, in this order:

1. The trade in plain words: "Buy YES on 'BTC above the strike at 3:15 PM' at about 62 cents."
2. An amount field, defaulting to $5, with the remaining daily allowance beside it.
3. A tip selector: none, 0.10, 0.25 or 0.50 USDC.
4. The outcome box, computed from the whole number of contracts the amount buys. At 62 cents, $5 buys 8 contracts: "Most you can lose: $4.96. If right you receive $8.00." Below it: "The tip goes to the author only if the thesis is right. If it is wrong, the tip comes back to you."
5. A line stating the mode: "Simulated fill at Gemini's live price" or "Order placed in your Gemini sandbox account".
6. A Confirm button, disabled until the numbers have loaded.

After confirming, the dialog shows the fill, then the tip moving through pending and escrowed with an explorer link. On `price_moved` it shows the new price and asks again.

**OddsChart.** A line of YES price over time from `price_points`, with one dot per thesis at its publish time: one color for AI, another for human, upward triangle for YES and downward for NO. Hovering or tapping a dot shows the headline and links to the thesis. Use Recharts with `ReferenceDot`, or Lightweight Charts with series markers. For 15-minute contracts, show the strike and the countdown beside the chart.

**DisagreementBar.** A 0 to 100 scale with three labeled markers: market price, average AI probability, average human probability. Show the gap in points and the number of theses behind each average. Hide a marker that has no theses.

**AuditPanel.** Lists each extracted claim with its status and source link. Unsupported and contradicted claims are highlighted. A sentence explains that the check is automated and can be wrong.

**ThesisEditor.** Enforces the format: a headline of up to 90 characters, a body of up to 1,200, at least one evidence row with a URL, a probability, a side consistent with that probability relative to the current price, and a stake of at least $1. On submit it shows the audit running, then either the published thesis or the reason it was blocked.

### States every page must handle

- Loading: skeleton rows, never a blank page.
- Empty: a sentence and a next action, such as "No human theses yet. Write the first one."
- Error: the `message` from the API and a retry button.
- Market closed or expiring within 2 minutes: Copy trade is disabled with the reason shown.
- Limit reached: the dialog shows which cap was hit and when it resets.
- Trading switched off: a banner on every page, and all trade buttons disabled.

### Style

Keep it plain and legible: one accent color, green and red only for YES and NO and for profit and loss, prices in cents, probabilities as whole percentages, all times in the viewer's time zone with a countdown for anything under an hour. Use shadcn/ui components to avoid building primitives.

## Chrome extension

The extension does one thing: on x.com, it adds a small card under posts that match one of the tracked markets, and the card's button opens the website. Build it only after the core flow works end to end.

### Scope

- One site: `x.com`. No Google results, no news sites.
- Only the 8 to 12 tracked markets. No free-text search of all Gemini markets.
- Read-only. No trading, no wallet, no sign-in inside the extension.
- Loaded unpacked in developer mode for the demo. No Chrome Web Store submission.

### Why it differs from an odds overlay

Odds overlays for Polymarket are common. This card shows reasoning, not just a price: the best AI thesis and the best human thesis for the market, each with the author's record, and a way to act on it.

### Files

```
apps/extension/
  manifest.json        Manifest V3
  src/content.ts       Finds posts, matches, mounts cards
  src/background.ts    Service worker: fetches from the API, caches
  src/card.ts          Renders the card inside a shadow root
  src/match.ts         Pure matching function, unit tested
  build.mjs            esbuild script, outputs dist/
```

Manifest essentials: `manifest_version: 3`; a content script matching `https://x.com/*`; a background service worker; `host_permissions` for `https://x.com/*` and the site's API origin; the `storage` permission. Request nothing else.

### Matching

1. On start, and every 5 minutes, the background worker fetches `GET /api/ext/markets` and stores the result in `chrome.storage.session`. Each market has `symbol`, `title`, and `keywords`, a list of groups. A post matches a market when every term in at least one group appears in the post, ignoring case. Example for a Bitcoin market: `[["bitcoin"], ["btc"], ["$btc"]]`. Example for a Fed market: `[["fed", "rate"], ["fomc"], ["powell", "cut"]]`.
2. The content script watches the page with a `MutationObserver` and reads the text of each new post. X marks posts as `article[data-testid="tweet"]` and their text as `[data-testid="tweetText"]`. **Verify** these selectors on the live site; they change without notice, so keep them in one constants file.
3. Matching runs locally in the content script. Post text never leaves the browser.
4. For a match, the content script asks the background worker for the card, which fetches `GET /api/ext/card?symbol=` and caches each answer for 30 seconds.
5. Mark each processed post with a data attribute so it is never processed twice. Show at most one card per post, for the market with the most matched terms, and at most five cards on screen.

Keyword groups are written by hand for each tracked market and stored in `markets.keywords`. With a dozen markets this takes minutes and avoids false matches that an LLM matcher would need tuning to prevent.

### The card

- Mounted directly after the post's text, inside a shadow root so X's styles and the card's styles cannot affect each other.
- Row 1: the market title and the YES price as a percentage.
- Row 2: "AI:" with the top agent thesis, its side, headline and the author's record.
- Row 3: "Human:" with the top human thesis in the same shape, or "No human thesis yet".
- A button, "See theses and copy", opening `https://<site>/markets/<symbol>?src=ext` in a new tab.
- A small close control that hides cards for that market for the session.
- "Top" means the published thesis from the author with the best Brier score among those with at least three resolved theses; before any author qualifies, the most recent thesis.

### Build and demo

- `node build.mjs` bundles TypeScript to `dist/`. Load `dist/` at `chrome://extensions` with Developer mode on.
- The API routes under `/api/ext/` must send CORS headers allowing the extension's origin.
- For the video, prepare two or three real posts that match, for example by opening a search for "Bitcoin" on X, and confirm the card appears before recording.

## Safety limits and guardrails

Every limit below is a pure function in `packages/core/limits.ts`, checked on the server immediately before the action it protects, with a unit test for the boundary on each side.

### Agent limits

| Limit | Default | When hit |
| --- | --- | --- |
| Starting bankroll | $1,000 of test funds per agent | Fixed |
| Maximum per trade | $20 | Order is reduced to the cap |
| Maximum open exposure | $150 across all open positions | Skip, logged |
| Positions per contract | One, and never the opposite side of an open position | Skip, logged |
| Daily loss stop | $50 of realized loss in a UTC day | Agent is halted until the next UTC day; its profile shows "Halted: daily loss stop" |
| Trades per day | 30 | Skip, logged |
| Price band | Never buy below 0.05 or above 0.95 | Skip, logged |
| Maximum spread | 0.06 | Skip, logged |
| Time to expiry | At least 3 minutes | Skip, logged |
| Edge re-check | The edge must still exist after the audit finishes | Skip, logged |
| Consecutive errors | 5 | Agent is halted until a person restarts it |

The limits are shown on each agent's profile. Showing an agent stopping itself is a stronger demonstration than claiming it is safe.

### User limits

| Limit | Default | Notes |
| --- | --- | --- |
| Maximum per copy trade | $10 | The user may lower it at any time |
| Daily copy cap | $25 per UTC day | Raising it takes effect the next UTC day; lowering is immediate |
| Tip per copy | Up to 0.50 USDC in the app; 5 USDC per thesis in the contract | The app limit is the tighter one |
| Confirmation | Every copy trade shows the most the user can lose before they confirm | No one-tap or automatic copying |
| Slippage guard | Reject if the ask is more than 0.05 above the author's entry price | The user is shown the new price and asked again |
| Own thesis | A user cannot copy or tip their own thesis | Prevents inflating tip totals |
| Rate limit | 10 write requests a minute per session | Returns 429 |

### Author rules

- An author must hold a position on the side they argue before the thesis is published. The minimum stake is $1.
- The position cannot be sold through the app. The record uses the entry price at publication, so a later change elsewhere cannot improve it.
- A thesis cannot be edited or deleted after publication. The content hash on Arc proves the text.
- One thesis per author per contract.
- Tips are paid only on a correct outcome. Popularity alone earns nothing.

### Content rules

- A thesis that claims inside or non-public knowledge is blocked. The editor says so before the author starts: "Argue from public evidence. Theses claiming inside information are not published."
- Blocked categories: threats, harassment, personal data about private people, and encouragement to manipulate a market.
- Flagged claims are shown, not hidden, so readers can judge.
- The auditor's output is labeled as automated.

### LLM safety

- LLM output is always parsed against a schema. An LLM never chooses the order size, price or account.
- Text from theses and web pages is passed as data. The system prompt for every call says that instructions inside that data must be ignored.
- Agents and the auditor can search the web and nothing else.
- Each LLM call has a timeout and a daily spend cap, tracked by token count in the database.

### System controls

- `TRADING_ENABLED=false` or the kill-switch route stops all orders at once, for agents and users. Reading the site still works.
- All Gemini secrets, Circle secrets and chain keys live only in server environment variables.
- OAuth tokens are encrypted at rest. Request only the two order scopes.
- Every order, tip and settlement is written to the database with its request id before the external call and updated after it, so a crash leaves a visible trail.

### Notices shown to users

- "Simulated funds" on every page while the build uses test money.
- On the how-it-works page: this is a hackathon prototype; theses are opinions, not financial advice; AI agents lose money often; past accuracy over a small number of markets says little about the future.
- The leaderboard states how many resolved theses each rank is based on.

## Build phases and schedule

The build runs in seven phases over four days, and the core flow must work end to end by Wednesday night so that Thursday is for payout hardening, the stretch work and the video.

&#91;embedded content: build roadmap · 5 days, 1 gate\]

The gate between Wednesday and Thursday is the one decision point: if the core flow is not working, Thursday goes to finishing it and the extension is cut.

All times are Pacific. The deadline is Friday, November 20 at 10:00 AM.

| Phase | When | Build | Done when |
| --- | --- | --- | --- |
| 0. Verify and scaffold | Mon evening | Run `scripts/verify-gemini.ts` against every **Verify** item. Create the Gemini sandbox, Circle, Supabase, Vercel, Railway, QuickNode and LLM accounts. Scaffold the workspace and schema. Deploy an empty web app and worker. Start a minimal price recorder. Pick the tracked markets. Start requesting faucet USDC. | Findings are written to `docs/gemini-findings.md`. `TRADING_MODE` is decided. The deployed worker is writing `price_points` for at least six symbols. |
| 1. Market data and Markets tab | Tue morning | Full recorder with WebSocket and backfill. `/markets` and `/markets/[symbol]` with the odds chart. | Live odds match Gemini's site. The chart updates without a reload. The recorder recovers after its socket is killed. |
| 2. Trading and agents | Tue afternoon and evening | `TradingAdapter`, limits with tests, the `momentum` agent, paper settlement in the resolver, agent profiles. | `momentum` has placed at least three trades with `agent_runs` rows. A test shows the daily loss stop halting an agent. A 15-minute position settles with the correct payout. |
| 3. Theses, auditor, feeds | Wed morning | LLM wrapper, auditor, thesis pipeline, AI feed, Human feed, thesis page, editor, the `news` and `fade` agents. | The AI feed shows theses with audit results. A human thesis publishes. A thesis claiming inside knowledge is blocked. A thesis with a false claim is flagged. |
| 4. Escrow, wallets, copy trade | Wed afternoon and evening | Contract, tests and deployment. Circle wallets and funding. Registrar. Copy-trade route and dialog. Tip confirmer. On-chain settlement in the resolver. | Foundry tests pass. The contract is deployed and verified. A guest copies a trade and the tip is visible in escrow on the explorer. Each limit rejects correctly. |
| **Gate** | Wed night | Run the whole loop on a 15-minute contract without touching the database by hand: agent thesis, copy with tip, resolution, payout or refund on-chain, record updated. | It works twice in a row, once with the author right and once wrong. |
| 5. Records and polish | Thu morning | Leaderboard, author pages, disagreement bar, live strip, `/me`, how-it-works page, empty and error states, phone layout. The team writes at least five real human theses. | A new visitor can understand the product and copy a trade in under a minute on a phone. |
| 6. Stretch | Thu afternoon | In this order: Chrome extension, QuickNode Stream webhook, Gemini sandbox OAuth connect. | Each is finished or removed by 6:00 PM. Nothing half-built ships. |
| 7. Submission | Thu evening | README with setup, architecture and trust assumptions. Record the video. Write the five answers. Freeze code at 10:00 PM. | Everything in the submission checklist is ready except the final form. |
| Submit | Fri by 8:00 AM | Check the deployed app, agents and recorder. Submit. | Submission is confirmed two hours before the deadline. |

### Working in parallel

The phases assume the work is split into lanes that meet at the database schema and the API route list, both of which are fixed in Phase 0.

| Lane | Owns |
| --- | --- |
| Data and agents | Recorder, `TradingAdapter`, limits, agents, resolver |
| Web | All pages and components, against mock API responses until the real routes exist |
| Chain | Contract, tests, deployment, Circle wallets, registrar, tip flow |
| Trust and story | Auditor, LLM wrapper, seeded theses, how-it-works page, README, video, written answers |

With fewer people, merge "Chain" into "Data and agents" and "Trust and story" into "Web".

### Sponsor office hours

Sponsors hold workshops and office hours from November 16 to 19. Use them early for the three questions that change the build:

- **Gemini:** Does the sandbox list prediction markets? Can a sandbox OAuth app place prediction market orders? Does a project using live public data with simulated fills satisfy the bounty's API requirement?
- **Circle and Arc:** Is gas sponsored for developer-controlled smart contract accounts on Arc testnet, and is there a faster way to get test USDC than the public faucet?
- **QuickNode:** Is Streams on Arc testnet available on the free plan?

### Cut order

If a phase runs late, cut from the top of this list and keep going: Gemini OAuth connect, QuickNode Stream, Chrome extension, the `fade` agent, the disagreement bar, the thesis editor's live preview. Do not cut the copy-trade flow, the on-chain payout, the auditor, the limits or the README.

## Testing, demo script, and submission checklist

Test the money paths automatically, rehearse the demo against a real 15-minute contract, and prepare every submission item on Thursday.

### Automated tests

| Area | Tool | Must cover |
| --- | --- | --- |
| Limits | Vitest | Each limit at, just under and just over its boundary |
| Order building | Vitest | Quantity rounding to `quantityIncrement`, prices as strings, rejection below `quantityMinimum` |
| Paper fills and settlement | Vitest | Fill at the ask, partial fill on thin size, payout for YES and NO outcomes, balance never negative |
| Scoring | Vitest | Brier score against hand-computed cases, including a 50% forecast scoring 0.25 |
| Momentum model | Vitest | Probability is 0.5 at the strike, rises with distance above it and as time runs out |
| Extension matching | Vitest | Each keyword group example, case-insensitivity, no match on unrelated posts |
| Escrow | Foundry | The eight cases in "Escrow smart contract" |
| Gemini parsing | Vitest with recorded responses | Real event JSON saved in Phase 0 parses under the zod schemas |
| Idempotency | Vitest with a test database | Repeating a copy request or a resolver run changes nothing the second time |

### Manual checks before recording

1. Fresh browser, no cookies: open the site on a phone, copy a trade, see the tip reach escrow.
2. Wait for resolution: the thesis shows Right or Wrong, the tip is paid or refunded on the explorer, the leaderboard changes.
3. Hit each user limit on purpose and read the message.
4. Submit a thesis claiming inside knowledge and one containing a false fact.
5. Turn the kill switch on and confirm no order can be placed.
6. Stop and restart the worker mid-resolution and confirm nothing is paid twice.

### Demo video (2 to 3 minutes)

A 15-minute contract takes up to 15 minutes to resolve, so record the copy trade and the resolution as two takes on the same contract and cut between them. Do not fake the resolution.

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | The AI feed | Prediction markets show a price but not the reasoning behind it. Here every bet comes with a thesis you can check and copy. |
| 0:20 | One agent thesis, its audit panel and the agent's limits | Each agent trades Gemini markets inside hard limits, and an auditor checks every claim against sources. |
| 0:45 | A market page: the odds chart with thesis markers, the disagreement bar | Odds over time, with the moment each thesis was published, and where AI, people and the market disagree. |
| 1:05 | Copy trade on a BTC 15-minute contract: the confirmation, the fill, the tip reaching escrow on the explorer | One tap copies the trade into my own account. The tip waits in escrow on Arc. |
| 1:35 | Cut to resolution: the thesis marked Right, the payout transaction, the leaderboard | The market resolved. The escrow paid the author because the call was right. Had it been wrong, the tip would have come back. |
| 2:00 | The Human tab, a blocked inside-information thesis | People publish in the same format, on the same record. Claims of inside knowledge are blocked. |
| 2:20 | The extension card on an X post, clicking through | The same theses appear where people read the news. |
| 2:35 | The how-it-works page | What is live: Gemini's markets, prices and resolutions, and the escrow on Arc. What is simulated: the fills. Next: production OAuth so copies route real orders to Gemini. |

If the extension was cut, use that time for the agent halting at its daily loss stop.

### How the build maps to what judges asked for

| Requirement | Where it is met |
| --- | --- |
| Gemini bounty: odds-over-time analytics | Price recorder, odds chart with thesis markers |
| Gemini bounty: trading tools, bots, AI agents | Three agents with limits, copy trade |
| Gemini bounty: bring prediction market data into other apps | Chrome extension on X |
| Gemini bounty: improve discovery and understanding | Theses, auditor, disagreement bar, Markets tab |
| Gemini bounty: uses the Prediction Markets API | Events, prices, resolutions; orders in sandbox mode |
| Consumer track: blockchain interaction | Tip escrow, thesis hashes, payouts on Arc |
| Consumer track: working user-facing frontend | The deployed website |
| Best use of Arc | USDC escrow, USDC as gas, Circle wallets |
| QuickNode Streams (stretch) | Escrow events delivered by a Stream to the live strip |

### Submission checklist

- [ ] Project name, description and team members
- [ ] Main track (Consumer Applications), chain award (Arc), bounties (Gemini; QuickNode if built)
- [ ] Five written answers: what you built, the problem, how it works, what makes it unique, what comes next
- [ ] Technologies used
- [ ] Public GitHub repository with setup instructions
- [ ] README with the architecture diagram, the trust assumptions, what is simulated, the contract address and a sample payout transaction
- [ ] Deployed app link that works without sign-in
- [ ] Demo video of 2 to 3 minutes
- [ ] Any track-specific items listed in the guide
- [ ] Agents and recorder still running on judging day, Saturday, November 21

In the written answers, describe the product as opening up reasoning from public evidence. Do not describe it as surfacing information that is not public, and do not call copy trading "investing in a bot": the user's funds stay in the user's own account.

## Open questions and risks

Twelve facts could not be confirmed from documentation, and the first three decide how the trading path is built, so resolve them in Phase 0 before writing code that depends on them.

### Verify in Phase 0

| # | Question | How to check | If the answer is no |
| --- | --- | --- | --- |
| 1 | Does Gemini's sandbox list prediction market events, and can orders be placed there? | `GET https://api.sandbox.gemini.com/v1/prediction-markets/events`, then one small order with a sandbox API key | Set `TRADING_MODE=paper` for everyone. Label fills as simulated. The rest of the build is unchanged |
| 2 | Do sandbox symbols and resolutions match production? | Compare tickers and a settled event on both hosts | Agents and users trade in paper mode against production data; sandbox is used only to demonstrate the order call |
| 3 | Do the OAuth authorize and token paths work on `exchange.sandbox.gemini.com`? | Register a sandbox app and try the flow | Cut Gemini OAuth connect and describe it as the production path |
| 4 | For `outcome: "no"`, is `price` the price of NO? | The SDK reference does not say; place a tiny sandbox order and read the fill | Convert in the adapter: NO price = 1 minus YES price |
| 5 | What are the fees on prediction market orders? | Gemini's fee schedule or office hours | Model zero fees in paper mode and say so |
| 6 | Is `priceHistory` filled for short contracts, and at what interval? | Inspect one 15-minute event | Charts for short contracts start when recording started |
| 7 | Which assets have 15-minute events right now? | List active events and filter tickers containing `15M` | Use BTC only for the short contracts |
| 8 | Are there non-crypto markets that resolve by Thursday? | List active events sorted by `expiryDate` | The `news` agent trades daily crypto contracts, and longer markets appear as open theses only |
| 9 | Which sandbox WebSocket host is correct? | Try both | Poll REST |
| 10 | Which Arc testnet RPC host answers, and is the USDC address correct? | `eth_chainId` on both hosts; read `decimals()` on the token | Use a QuickNode Arc endpoint |
| 11 | Does a Circle smart contract account on Arc testnet transact without holding gas? | Create one wallet and call `approve` | Fund each wallet with a little extra test USDC for gas |
| 12 | Do the X selectors still match? | Inspect a post in Chrome DevTools | Update the constants file |

The SDK's package name appears as `@gemini-markets/sdk` in the reference's import path; confirm it installs before relying on it, and fall back to signed `fetch` calls if it does not.

### Risks to plan around

- **Rules fit.** The Gemini bounty requires using the Prediction Markets API. Live data, live resolutions and sandbox orders should meet that, but if only paper fills are possible, confirm with Gemini's team that this counts. Ask on the first day of office hours.
- **Test USDC supply.** Every guest wallet is funded with 2 test USDC and the faucet is rate-limited. Request from the faucet repeatedly from Monday, to more than one team address, and lower the welcome amount if supply is short.
- **Thin theses on short contracts.** A 15-minute Bitcoin contract leaves little to argue. It is in the build because it resolves on camera. Make sure the feed also has longer markets with real reasoning, including the team's own human theses.
- **Agents may lose.** Public benchmarks of AI trading on prediction markets show most models losing money. Present the record as it is. The product's claim is that reasoning and records are visible, not that the agents win.
- **Small samples.** By Friday each author will have few resolved theses. The leaderboard must show the count and say it is an early sample.
- **LLM cost and latency.** Web-search calls are slow and metered. Cap calls per agent per hour, cache auditor results by content hash, and keep the `momentum` agent free of LLM calls in its decision path.
- **Resolution lag.** Gemini may set `resolutionSide` some time after expiry. Measure the lag in Phase 0 and plan the video around it.
- **Built during the hackathon.** Projects must be substantially built during the event. Commit early and often so the history shows it.
- **Regulation, if this continues past the hackathon.** Paying authors for trade ideas, copy trading, and tips tied to outcomes each raise questions for a real-money product on a regulated exchange. This document is not legal advice; a real launch needs a lawyer and Gemini's agreement. The hackathon build uses test funds only.

### Decisions the team still owns

- The product name.
- Which 8 to 12 markets to track, chosen after Phase 0 shows what is listed.
- Whether to enter the QuickNode bounty, decided at the Wednesday gate.
- The LLM provider and model, chosen for web search quality and speed.

## Sources

Gemini developer documentation, read November 16, 2026:

- [Prediction Markets overview](https://developer.gemini.com/products/prediction-markets)
- [Markets API schema](https://developer.gemini.com/prediction-markets-spec/markets)
- [Crypto contract tickers](https://developer.gemini.com/prediction-markets/tickers-crypto)
- [WebSocket streams](https://developer.gemini.com/prediction-markets/websocket/streams)
- [OAuth 2.0](https://developer.gemini.com/authentication/oauth.md)
- [Sandbox](https://developer.gemini.com/get-started/sandbox)
- [Rate limits](https://developer.gemini.com/rate-limit)
- [TypeScript SDK: order management](https://developer.gemini.com/tools/typescript-sdk/reference/predictions/order-management.md)

Arc, Circle and QuickNode:

- [Arc: connect to Arc](https://docs.arc.io/integrate/connect-to-arc)
- [Arc: wallets and USDC contract](https://docs.arc.io/integrate/wallets.md)
- [Arc: RPC endpoints and faucet](https://docs.arc.io/arc/references/rpc-endpoints.md)
- [Circle: developer-controlled wallets](https://developers.circle.com/wallets/dev-controlled.md)
- [Circle: contract execution API](https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-contract-execution)
- [Circle: calling smart contracts with Circle Wallets](https://www.circle.com/fr/blog/calling-smart-contracts-with-circle-wallets)
- [Circle faucet](https://faucet.circle.com)
- [QuickNode Streams: supported chains](https://www.quicknode.com/docs/streams/supported-chains)
- [QuickNode: Arc](https://www.quicknode.com/chains/arc)

Hackathon rules: the UBC 2026 Hackathon Guide in this project, pages 12 and 16 to 18.
