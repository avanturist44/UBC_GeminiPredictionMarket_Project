# Thesis Market agents

Updated November 18, 2026. Implementation described here is on `avi/ubc-hack`.

## What we are working on now

**The current trading agent is BTC 15-minute `momentum`, and the second agent is the log-only Grok-powered `news` research pipeline.** Momentum uses Gemini's live prediction market data, computes its own YES/NO probability, publishes numeric reasoning, and holds simulated positions until Gemini resolves the contract. News uses Grok 4.7 web search to assess daily crypto and non-crypto markets and logs forecasts and hypothetical decisions. A live cited research run is verified; news execution remains disabled.

Momentum does not use Grok, Grokbot, or another LLM to decide trades. Its rules and probability calculation are ordinary TypeScript code. News now has the xAI Grok provider integration, with strict forecast validation and citation provenance. Grokbot is not required. See [the news agent runbook](news-agent.md).

## Agent types and implementation status

| Agent or component | Type | Purpose | Current status |
| --- | --- | --- | --- |
| BTC `momentum` agent | Deterministic quantitative trading strategy | Estimate the probability of BTC finishing above a 15-minute strike and buy YES or NO when estimated edge clears the limits | Implemented; live paper-trading acceptance pending |
| Paper executor | Execution component used by `momentum` | Simulate a fill at fresh executable quotes, enforce size and risk limits, and write the position and thesis atomically | Implemented and tested |
| Settlement worker | Official-outcome accounting component | Read Gemini's result and settle paper positions and theses exactly once | Implemented and tested; settlement of a live paper position still pending |
| Price recorder and observer | Market-data and monitoring components | Discover markets, collect the index and books, build volatility history, and log skips and health | Running against local Postgres and live Gemini data |
| `news` agent | Grok 4.7 web-search research with code-controlled policy | Validate evidence-backed forecasts and log hypothetical daily crypto/non-crypto entries | Live cited research verified; log-only, no execution or published theses |
| `fade` agent | Planned price-move strategy assisted by an LLM and web search | Investigate a sharp price move and consider a reversal when no public explanation is found | Not implemented; deferred |
| Thesis auditor | Planned evidence-verification agent | Check factual claims and flag unsupported claims or claims of non-public information before publication | Not implemented |

The executor, settlement worker, and recorder support the trading agent. They are not separate trading strategies. Although the recorder tracks other markets, current trading is restricted to BTC 15-minute contracts. ETH trading is not enabled.

## How the BTC agent decides

1. Read the BTC index from Gemini's verified Lukka stream and the contract's strike and expiry from Gemini market metadata.
2. Collect 31 consecutive completed one-minute closes to calculate 30 log returns and their sample volatility. Missing minutes prevent readiness; process restarts clear this in-memory history.
3. Estimate the probability of finishing at or above the strike using the plan's normal model:

   `p(YES) = Φ(ln(index / strike) / (volatility_per_minute × sqrt(minutes_remaining)))`

4. Compare `p(YES)` with the YES ask, and `1 - p(YES)` with the NO ask. The NO ask is `1 - YES bid` and its available size comes from the YES bid size.
5. Enter only if estimated edge is at least 8 cents, the spread is at most 6 cents, 3–12 minutes remain, the market is active and open, and index and quote data are at most 10 seconds old.
6. Recheck the executable signal and limits around the database transaction. If the book changes or expires while writes are in flight, roll back the proposed fill.
7. Publish a deterministic thesis explaining the index, strike, time remaining, volatility, estimated probability, entry price, edge, and simulated quantity.
8. Hold the position to official resolution. A winning contract pays $1, a losing contract pays $0, and an official invalid result refunds cost.

Despite its `momentum` name, the current formula estimates finish probability from distance to strike and volatility. It does not independently measure trend strength or use an LLM's opinion. Model probability is an estimate, not proof of an advantage or a profitability claim.

## Trading limits

| Control | Current behavior |
| --- | --- |
| Funds | $1,000 simulated starting bankroll |
| Stake | $10 target; $20 maximum per trade |
| Open exposure | $150 maximum across all open positions |
| Daily loss stop | Halt at realized PnL of -$50 or lower for the UTC day |
| Daily trade count | At most 30 |
| Position duplication | One position per contract; retries and opposite-side attempts cannot add another |
| Entry price | Between $0.05 and $0.95 |
| Fill size | Rounded down to the quantity increment, available book size, budget, and remaining exposure |
| Fees | Zero in the paper simulation |
| Execution mode | Paper only; no signed Gemini order path |
| Kill switch | `TRADING_ENABLED=false` prevents new entries; settlement continues |
| Repeated agent errors | Five consecutive recorded errors create a durable halt requiring operator intervention |

## Gemini, Circle, and AI responsibilities

- **Gemini:** live index, order books, market metadata, strikes, and official contract outcomes.
- **BTC worker and Postgres:** decision rules, simulated bankroll and fills, public thesis records, idempotency, limits, and settlement accounting.
- **Circle wallet and Arc testnet USDC:** planned tipping and escrow payout flow. The funded Circle wallet is not connected to the current worker, and its USDC balance is separate from the paper bankroll.
- **LLM provider:** xAI Grok 4.7 is connected for news research. The BTC numeric thesis remains a template. AI auditing and on-chain registration are still pending.

## What has actually been verified

- 182 repository tests and the full typecheck passed during the latest code verification, including news-policy, observer, and Grok adapter tests. A live Grok 4.7 forecast with six cited URLs passed provenance checks and was saved locally; entry was skipped for a missing/stale book.
- Tests cover YES/NO pricing and payouts, daily loss halting, retries, rollback, warmup, stale inputs, exposure and UTC boundaries, and missing-market logging.
- Two independent real local Postgres connections produced one fill under concurrent entry attempts and one payout under concurrent settlement attempts. These used an isolated fixture database and do not count as live trading acceptance.
- Local Postgres is configured, and the background worker has stored live Gemini price points and agent decision logs.
- The November 18 connectivity check succeeded for Gemini REST, a recent official outcome, BTC index, and book messages. The sampled book was one-sided, which does not satisfy the trading strategy's entry requirements.
- At the latest progress check, there were **zero paper fills and zero settled paper positions**. The recent worker logs show reconnection and incomplete volatility warmup. Three qualifying live paper trades and a correctly settled live position are still pending.

## Next steps

1. Observe a complete, uninterrupted volatility warmup and fresh executable BTC input.
2. Let the unchanged strategy and limits produce three qualifying paper trades with linked theses and decision logs.
3. Verify a position settles from Gemini's official YES/NO result, then verify a repeated settlement does not change payout or PnL twice.
4. Continue Grok-powered news research in log-only mode. Add auditing and shared limits before enabling news paper execution. Circle/Arc tipping, payouts, and copy trade remain later integrations; fade remains deferred.

See [the BTC worker runbook](btc-paper-worker.md) for configuration, commands, and operational details. Check current database progress with:

```powershell
corepack pnpm --filter @thesis/worker check:btc-paper
```

This is a read-only report. Exit code 2 means the live paper criteria remain pending.
