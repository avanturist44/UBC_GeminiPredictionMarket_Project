# BTC paper worker

The BTC worker uses production Gemini public data and simulated fills only. There is no signed order path. `BTC_BOT_MODE=paper` is the default; `log-only` retains the observer without execution. `TRADING_ENABLED=false` blocks entries while settlement continues. Environment changes require restarting the worker.

## Execution and accounting

- The existing Gemini socket supplies the Lukka BTC index and YES book. The worker requires 30 consecutive completed one-minute returns (31 minute closes), plus a fresh current index; a restart or missing minute requires warming up again. No historical observations are invented.
- Entry requires 3–12 minutes to expiry, an open active BTC 15-minute contract, a matching index source, inputs no more than 10 seconds old, spread at most 6 cents, and estimated edge at least 8 cents. NO buys at `1 - YES bid`, limited by bid size; YES uses ask and ask size.
- Default stake is $10, maximum $20, maximum open exposure $150, starting bankroll $1,000, maximum 30 trades per UTC day, price band $0.05–$0.95. Size rounds down to Gemini's quantity increment and available top-of-book size. Money uses exact integer arithmetic at the existing schema's four-decimal precision; unrepresentable fills are skipped. Paper fees are zero.
- A transaction locks the momentum author across all days and processes. It rechecks fresh inputs, limits, and prior positions, then atomically writes a deterministic thesis, locked paper trade, accounting update, and `agent_runs` decision. The existing unique idempotency key prevents duplicate fills. One position per contract is retained even after settlement.
- The thesis contains the numeric model reasoning and a Gemini link. It has Keccak IDs/content hashes but no on-chain registration or AI audit/summary. Those integrations remain later work.
- Settlement polls the exact Gemini event and contract after expiry. Only official `resolutionSide` pays winners $1 per contract and losers $0; official `invalid` refunds cost. Settlement and retry are atomic and idempotent. Realized PnL belongs to the UTC day when processed, while exposure and bankroll include positions from every day.
- At realized daily PnL of -$50 or lower, the bot halts for that UTC day. A five-consecutive-error halt persists across restarts and dates. After investigating, an operator must clear the `consecutive errors` halt rows in `agent_state`; a restart alone deliberately does not clear them. Database outages prevent trading; if Postgres itself is unavailable, errors can only be written to the process log.

## Verification performed November 17, 2026 (Pacific)

`corepack pnpm test` (155 tests) and `corepack pnpm typecheck` cover the repository, including embedded Postgres (PGlite) tests for three paper fills with decision logs, YES/NO pricing and payout, duplicate retries, transaction rollback, invalid refunds, exact money, size limits, warmup and hypothetical YES/NO logs, stale data, kill switch, exposure across midnight, count limits, persistent error halts, and a settlement reaching exactly -$50 and preventing another trade. A changed book during database writes rolls back the entire proposed fill.

`corepack pnpm --filter @thesis/worker verify:btc` reached Gemini production REST and WebSocket. It observed:

- `BTC15M2611180445`: active/open, strike `64497.37`, source `lukka:LS-LRRR-XBTUSD`.
- The live YES book with bid/ask quantities and BTC index `64397.637`, about 2.7 seconds old.
- `BTC15M2611180430`: official YES outcome, resolved `2026-11-18T04:30:05.570Z`, settlement index `64497.369166666664`.

The observed book's spread exceeded 6 cents, so it would correctly skip entry. These observations prove public connectivity, not live paper fills.

**Live Phase 2 exit criteria are still pending.** The initial run had no `.env` or `DATABASE_URL` and failed environment validation. After receiving the team's configuration, a read-only connection check reached the hosted Thesis Market database: all eleven public application tables exist, with 57 markets, zero paper trades, and zero momentum runs at the time checked. The local `localhost:5432` connection returned `ECONNREFUSED`.

The ignored root `.env` preserves `DATABASE_URL` for local development and keeps the hosted connection separately as `PROD_DATABASE_URL`. The worker reads only `DATABASE_URL`; it does not automatically switch to the hosted URL. No hosted migrations or application writes were performed during the connection check. The user selected isolated local Postgres for live-data verification. PostgreSQL 17.12 was installed under `.local/`, bound to `127.0.0.1:5432` with SCRAM password authentication, and the existing migrations were applied to local `thesis_market`. The worker was started against that local database to collect real Gemini input. Completed live warmup, three qualifying live paper entries, and settlement of a live paper position still need observation. Embedded database tests are not a substitute for those checks.

Real PostgreSQL concurrency was also checked in a temporary local database using two independent connections: simultaneous entry attempts produced exactly one trade and one accounting increment; simultaneous settlement attempts produced exactly one payout and PnL update. That database used synthetic signals and a fixture outcome and was dropped afterward. Those checks did not populate the live verification database or touch the hosted database.

## Local Postgres on Windows

Portable binaries come from [EDB's official archive page](https://productsdl.enterprisedb.com/download-postgresql-binaries), linked by [PostgreSQL's Windows download page](https://www.postgresql.org/download/windows/). The installed archive is `postgresql-17.12-1-windows-x64-binaries.zip`, extracted to `.local/postgresql-17.12/pgsql`. No Windows service or system PATH change is needed. Both binaries and database files stay ignored by Git.

After the archive is extracted, the helper initializes a cluster if needed, generates a local password, updates only a local `DATABASE_URL`, starts Postgres, and creates `thesis_market`. It refuses to replace a remote connection URL. It preserves `PROD_DATABASE_URL`.

Use PowerShell 7 for the helper. The first live local check observed 12 markets, 74 price points, six momentum decision rows, and zero paper fills during warmup. Decision rows contained real BTC index prices and book sizes; the skips were for missing volatility during warmup and contracts outside the entry window.

```powershell
.\scripts\local-postgres.ps1 start
corepack pnpm db:migrate
corepack pnpm start:worker
```

Use `.\scripts\local-postgres.ps1 status` to check Postgres and `.\scripts\local-postgres.ps1 stop` to stop it. The background verification worker's PID is in `.local/worker.pid`, and its logs are `.local/worker.out.log` and `.local/worker.err.log`. Postgres logs are in `.local/postgres.log`. Keep the background worker running during warmup; do not start a second worker simply to inspect logs.

## Maintenance and progress diagnostics

On November 17 (Pacific), repeated HTTP 500 responses were confirmed on the event, event-list, and recently-settled endpoints. [Gemini's maintenance notice](https://status.gemini.com/) lists Prediction Markets downtime from midnight to approximately 2 AM Eastern on November 18, equivalent to 9–11 PM Pacific on November 17. The independent WebSocket checks still received a fresh BTC index and book; that is not sufficient to replace official REST metadata or outcomes.

The worker now writes an explicit skip even when every tracked BTC market has expired. Those rows include index age, fresh-book count, completed minute closes, the contiguous return count, and volatility readiness. Normal cycle logs expose the same health data. Missing minutes reset the contiguous warmup count. Entry skips during warmup say how many of the required 30 returns are available.

`verify:btc` reports failed REST checks and still checks the book and index separately, using independent subscriptions so an invalid book cannot cancel the index request. A computed BTC symbol is used only for a clearly labelled diagnostic subscription when REST is unavailable; it never creates a tradable market or invents a strike. Failed checks exit with code 1 without an uncaught stack trace.

```powershell
corepack pnpm --filter @thesis/worker check:btc-paper
```

This read-only command reports unique BTC contracts with logged fills, correct settlement payouts, the latest decision, and agent state. Exit code 2 means live paper criteria remain pending, 1 means the check failed, and 0 means at least three contracts have logged paper fills, at least one has a correct official YES/NO settlement, and no examined settlement payout is wrong. A void refund alone does not satisfy the settlement criterion. The daily-loss-stop test is a separate requirement. Run this against the database populated by the live worker; synthetic tests must not be counted as live acceptance.

After the diagnostics changes, 157 repository tests and the full typecheck passed. Regression tests cover a database skip after every BTC contract expires and the exact boundary of 30 completed returns, including a missing-minute reset.

## Run against the configured database

Use Node >=22.4 and the repository-pinned pnpm (`corepack pnpm`). Put the owner/server Postgres `DATABASE_URL` in an ignored root `.env`, along with `TRADING_MODE=paper`, `TRADING_ENABLED=true`, and `BTC_BOT_MODE=paper`. Then:

```powershell
corepack pnpm --filter @thesis/worker verify:btc
corepack pnpm start:worker
```

The worker applies existing migrations; no new schema migration is needed. Allow at least 31 minutes of uninterrupted index collection, then enough contract windows for three qualifying entries. Thin books and the strategy's edge threshold can extend that wait. Do not weaken limits or seed synthetic observations to claim live acceptance.

Inspect decisions and fills using the server database connection:

```sql
select created_at, decision, reason, signal, error
from agent_runs where agent_key = 'momentum'
order by created_at desc limit 100;

select t.id, m.instrument_symbol, t.side, t.quantity, t.price, t.cost_usd,
       t.status, t.payout_usd, t.idempotency_key, t.thesis_id
from trades t join authors a on a.id = t.author_id
join markets m on m.id = t.market_id
where a.agent_key = 'momentum' and t.mode = 'paper'
order by t.created_at desc;

select * from agent_state where agent_key = 'momentum' order by day desc;
```

For a settled non-void fill, verify `payout_usd = quantity` when `side = markets.resolution_side`, otherwise zero. Re-run settlement/restart and confirm trade count, payout and PnL do not change twice.
