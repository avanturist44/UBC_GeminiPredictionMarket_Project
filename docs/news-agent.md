# News research agent

Updated November 18, 2026. Branch: `avi/ubc-hack`.

## Current scope

The second strategy is `news`: public-evidence research for tracked daily BTC/ETH contracts and tracked non-crypto markets. It runs in **log-only mode**, now with a verified **xAI Grok 4.7** provider adapter using web search and structured JSON output. A live research run was saved to local Postgres. Scheduled research remains disabled by default.

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

The caller may abort research, and the provider stage has a 90-second timeout. The Grok adapter forwards the signal to its HTTP call. Provider error messages are not persisted because they may contain credentials; only the error type (including HTTP status for xAI HTTP errors) is recorded. Five consecutive recorded research failures create a durable news halt requiring operator intervention.

The worker launches research without awaiting it in the BTC cycle. Market-data requests still share the existing rate-limited public Gemini client. No new database schema, SDK dependency, or additional stream is needed.

## Running it

News scheduling is **disabled by default**. To enable the research-only scheduler on the next worker start, set this in the ignored root `.env`:

```dotenv
NEWS_AGENT_ENABLED=true
```

Configure these server-only variables in the ignored root `.env`:

```dotenv
LLM_PROVIDER=xai
LLM_MODEL=grok-4.7
XAI_API_KEY=replace-with-your-key
```

Without that configuration, runs record `news research provider not configured`. With it, this one-shot command can make a metered Grok web-search request without restarting the BTC worker:

```powershell
corepack pnpm --filter @thesis/worker observe:news
```

The command subscribes to eligible market books while research runs, uses the configured database, and reports the latest forecast and decision. It preserves the durable 15-minute cadence and the four-request hourly cap. An initial configuration-only skip does not delay the first configured request; equal-timestamp rows cannot allow duplicate requests. The existing background BTC process was left uninterrupted during verification.

For an explicitly requested retry after a failed request, use `observe:news --retry-failed`. It cannot retry an in-flight or successful recent run, and it still enforces the hourly cap and durable error halt. Normal scheduled runs never bypass the 15-minute cadence.

Inspect decisions with the server database connection:

```sql
select created_at, market_id, decision, reason, signal, error
from agent_runs where agent_key = 'news'
order by created_at desc limit 30;
```

## Grok provider integration

`NewsResearchProvider.research(request, signal)` is the integration point. Its result contains the raw forecast, search timestamp, actual retrieved source URLs/titles, provider name, and model name. Gemini rules and article content must be treated as untrusted data in the model prompt. Source provenance must come from search-tool responses rather than generated prose.

`xai-research.ts` calls `https://api.x.ai/v1/responses` with the shared forecast JSON schema, `web_search`, no stored response, at most three tool calls and 2,500 output tokens. Grok 4.7 uses low reasoning effort to keep latency bounded. The model is configurable through `LLM_MODEL`; selecting access to all models does not run an ensemble.

The adapter requires a completed web-search call and a complete, schema-valid final response. Retrieved URLs come only from xAI's citation annotations or top-level citation metadata, never by promoting model-generated evidence URLs into provenance. The observer persists the retrieved source list alongside the forecast. Incomplete output, refusals, malformed JSON, and absent search activity fail closed. Raw upstream HTTP error bodies are neither retained nor logged.

The key is kept only in the ignored local environment file. No key belongs in source, tests, prompts, logs, or Git. The integration follows xAI's official [web-search](https://docs.x.ai/developers/tools/web-search), [structured-output](https://docs.x.ai/developers/model-capabilities/text/structured-outputs), [citation](https://docs.x.ai/developers/tools/citations), and [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) documentation, checked November 18, 2026.

Before enabling news paper execution, add and verify the thesis audit, shared financial limits, idempotent execution, and official settlement for news positions. Research confidence and citations do not replace those controls. Circle escrow and payouts remain separate work.

## Verification and remaining work

- All 182 repository tests and the full typecheck passed with the Grok integration.
- Twenty-five news-policy, observer, and adapter tests cover YES/NO pricing, the ten-cent boundary, malformed or execution-bearing model output, low confidence and abstention, missing/invented citations, source diversity, stale research/books, short-crypto exclusion, cadence (including equal timestamps), hourly budget, missing rules, post-research eligibility, cancellation, error redaction/halting, market rotation, xAI response parsing, configuration transitions, and bounded manual retries.
- A one-shot run against local Postgres created a news skip for missing provider configuration. No trades or forecasts were invented.
- A temporary local Postgres database tested two independent connections running concurrently: one fixture research request, one hypothetical decision, and zero trades. That database was dropped afterward; fixture forecasts are not live model verification.
- The supplied key successfully listed accessible xAI models. The first live Grok request timed out at 45 seconds; a bounded retry with low reasoning and a 90-second timeout returned a valid Grok 4.7 forecast with six cited URLs, passed provenance checks, and was saved locally. Entry was correctly skipped for a missing/stale book. No trades or published theses were created.
- Audited theses, news paper fills, and news settlement remain unimplemented. Live research and citation provenance are now verified; citation presence does not prove that every claim is factually correct. BTC live acceptance is tracked separately in [the BTC runbook](btc-paper-worker.md).
