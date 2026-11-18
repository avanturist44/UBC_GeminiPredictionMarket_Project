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

**Live Phase 2 exit criteria are still pending.** This workspace has no `.env` or `DATABASE_URL`; starting the worker fails explicitly with `Invalid worker environment: DATABASE_URL`. Therefore hosted Postgres writes, actual 30-minute live warmup, live hypothetical YES/NO decision rows, three live paper entries, settlement of a live paper position, and multi-process locking against hosted Postgres remain unverified. Embedded database tests are not a substitute for those checks.

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
