# News research agent

Updated November 18, 2026. Branch: `avi/ubc-hack`.

## Current scope

The second strategy is `news`: public-evidence research for tracked daily BTC/ETH contracts and tracked non-crypto markets. The user chose to build it in **log-only mode** and choose the model provider later, with **Grok preferred**. No Grok API integration or other live LLM adapter is present yet.

The provider-independent research pipeline, forecast schema, decision policy, scheduler, and database logs are implemented. It cannot place orders, create paper positions, publish theses, or move Circle funds. Even a qualifying forecast is stored as an `agent_runs` skip with reason `log only: hypothetical news entry`. BTC paper execution remains separate.

## Research and decision flow

1. Select one eligible tracked market every 15 minutes, preferring the least recently attempted market and then earlier expiry. Exclude all BTC/ETH/SOL/XRP 5-minute and 15-minute contracts. Crypto eligibility is restricted to daily BTC/ETH tickers.
2. Reserve the run transactionally under the news author's row lock before any model request. The timestamp survives process restarts. A rolling hourly cap permits at most four research requests, including failures.
3. Fetch the exact official Gemini event and contract. Require active/open status, at least three minutes remaining, and contract resolution rules. Send the title, contract label, description, rules, expiry, and current time to the research provider.
4. Require schema-validated JSON: `probability_yes`, `confidence`, `headline`, `body`, `evidence`, and `no_trade_reason`. Reject extra execution fields such as model-supplied side or quantity. Honor abstentions and low confidence.
5. Require at least two cited source hostnames after stripping `www.`, and require every citation URL to appear in actual search results returned by the provider. Different hostnames are a provenance check, not proof of editorial independence or factual accuracy. A model-generated URL alone is not retrieval evidence.
6. Refresh official eligibility and read the newest streamed book after research. Require research no older than 15 minutes, a two-sided quote no older than ten seconds, a spread no wider than six cents, and a price between five and 95 cents.
7. Calculate side and edge in code. YES uses the YES ask and ask size. NO uses `1 - YES bid` and the bid size. A hypothetical entry requires at least ten cents of estimated executable edge. Available quantity is diagnostic; no order size or fill is executed.
8. Persist the decision, validated forecast, research context, provider/model metadata, and quote in `agent_runs`. Mark the result as unaudited. No trade or published-thesis row is inserted.

The caller may abort research, and the provider stage has a 45-second timeout. Provider adapters must forward the abort signal to their HTTP calls. Provider error messages are not persisted because they may contain credentials; only the error type is recorded. Five consecutive recorded research failures create a durable news halt requiring operator intervention.

The worker launches research without awaiting it in the BTC cycle. Market-data requests still share the existing rate-limited public Gemini client. No new database schema, SDK dependency, or additional stream is needed.

## Running it

News scheduling is **disabled by default**. To enable the research-only scheduler on the next worker start, set this in the ignored root `.env`:

```dotenv
NEWS_AGENT_ENABLED=true
```

Until a provider adapter is added, scheduled runs record `news research provider not configured`. The BTC worker need not be restarted just to check the new agent once:

```powershell
corepack pnpm --filter @thesis/worker observe:news
```

This explicit one-shot command uses the configured database, preserves the durable 15-minute cadence, and reports the latest news decision. It does not call a model or fabricate a forecast. The existing background BTC process was left uninterrupted during this check.

Inspect decisions with the server database connection:

```sql
select created_at, market_id, decision, reason, signal, error
from agent_runs where agent_key = 'news'
order by created_at desc limit 30;
```

## Provider interface and later Grok integration

`NewsResearchProvider.research(request, signal)` is the integration point. Its result contains the raw forecast, search timestamp, actual retrieved source URLs/titles, provider name, and model name. Gemini rules and article content must be treated as untrusted data in the model prompt. Source provenance must come from search-tool responses rather than generated prose.

The preferred next adapter is Grok, subject to model selection and verification of its current search and structured-output API. Keep its key in server environment variables. No provider-specific API shape, model name, key variable, or paid request has been assumed here.

Before enabling news paper execution, add and verify the thesis audit, shared financial limits, idempotent execution, and official settlement for news positions. Research confidence and citations do not replace those controls. Circle escrow and payouts remain separate work.

## Verification and remaining work

- All 174 repository tests and the full typecheck passed after adding the agent.
- Seventeen focused tests cover YES/NO pricing, the ten-cent boundary, malformed or execution-bearing model output, low confidence and abstention, missing/invented citations, source diversity, stale research/books, short-crypto exclusion, cadence, hourly budget, missing rules, post-research eligibility, cancellation, error redaction/halting, and market rotation.
- A one-shot run against local Postgres created a news skip for missing provider configuration. No trades or forecasts were invented.
- A temporary local Postgres database tested two independent connections running concurrently: one fixture research request, one hypothetical decision, and zero trades. That database was dropped afterward; fixture forecasts are not live model verification.
- Live LLM research, real search-result provenance, the preferred Grok adapter, audited theses, news paper fills, and news settlement remain unverified or unimplemented. BTC live acceptance is tracked separately in [the BTC runbook](btc-paper-worker.md).
