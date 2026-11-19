# Model Arena Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five language models (Claude, Grok, GPT, Gemini, DeepSeek) each trade Gemini's prediction markets as their own agent with their own $1,000 paper ledger, mirror every trade as a real order from their own Gemini sandbox account, receive tips in their own Arc testnet wallet, and feed the `/arena` page with real data instead of sample data.

**Architecture:** Each model is an ordinary agent author (`agentKey = arena-<id>`), so the existing thesis pipeline already gives it a per-agent ledger, limits, audit, paper fill, on-chain registration (which creates its Circle payout wallet) and settlement. New work is: provider adapters behind the existing `LlmProvider` interface, per-model spend caps, one arena cycle that asks all five models the same question about the same market, a sandbox-mirror job that places each paper trade as a real order in that model's sandbox account, and a builder that turns real trades into the `ArenaResponse` the page already renders.

**Tech Stack:** TypeScript, Node 22, pnpm workspaces, Vitest with in-memory Postgres (`@thesis/db/testing`), Drizzle, Next.js 16, `@gemini-markets/sdk@0.1.1`, plain `fetch` for model APIs (no new SDK dependencies).

**Spec:** The "Decisions" section below (agreed with the product owner on 2026-11-19), the page contract in `apps/web/lib/arena-view.ts`, the build plan's `TradingAdapter` section (`Gemini thesis-trading app build plan and architecture (1).md`, lines 272–304), and `docs/gemini-findings.md` (sandbox order rules).

## Decisions

1. **Score on paper, mirror on the sandbox.** Account value on `/arena` is each model's paper ledger at Gemini's production prices. Every paper trade is also placed as a real immediate-or-cancel order from that model's own Gemini sandbox account. Sandbox results never change the score; they are shown as proof that the model holds an exchange account. (Sandbox prices come from bots and do not track production: `docs/gemini-findings.md`.)
2. **Five models:** Claude, Grok, GPT, Gemini, DeepSeek (Qwen is out). A model whose API key is not configured is left out of the arena, not faked.
3. **Arc testnet:** each model has its own Circle wallet, used only to receive tips. The existing registrar already creates an agent author's payout wallet on first registration (`apps/worker/src/onchain.ts`, `authorAddress`).
4. **Fairness:** in one arena cycle every model gets the same market and the same prompt at the same time. Side, size and price are decided in code from the model's probability, exactly as for the News agent.
5. **Retire sample data per environment:** `ARENA_SOURCE=live` makes `/arena` read real trades; `sample` keeps today's generated data. Live with no trades yet shows empty states, never sample numbers.

## Global Constraints

- Every model trades under `AGENT_RULES` unchanged (`packages/core/src/agents.ts`): $1,000 bankroll, $10 stake, $20 max per trade, $150 open exposure, $50 daily loss stop, 30 trades a day, price 0.05–0.95, spread ≤ 0.06, ≥ 3 minutes to expiry.
- A model never chooses side, size, price or account. `decideNews` (core) decides from `probability_yes`.
- Every arena thesis goes through the existing pipeline: `createAuditingThesis` → audit → paper fill → `register` → publish.
- The sandbox environment is fixed in code (`env: 'sandbox'`). There is no production order path anywhere in the repo.
- API keys, sandbox secrets and RPC tokens live only in environment variables and never appear in logs, errors stored in the database, or API responses.
- Arena model calls never consume the auditor's daily token budget.
- Copy: sentence case, no exclamation marks, no trailing periods on labels; the "Sample data" note shows exactly when `sample: true`.
- Next migration number is `0008`. Generate with `corepack pnpm db:generate`.
- Test command: `corepack pnpm exec vitest run <file>`; full suite `corepack pnpm exec vitest run --maxWorkers=3`; types `corepack pnpm -s typecheck`.

## Review Focus

1. **Arena spend starving the auditor:** five models researching hourly must not use the budget that audits people's theses. Pinned by `"arena calls never count against the auditor's cap"` in Task 2.
2. **One provider failing (timeout, 429, no credit):** the other models still trade that cycle; the failing one logs a skip, and five consecutive errors halt only that model. Pinned by `"one model failing does not stop the others"` in Task 4.
3. **Worker restart mid-order:** a sandbox order must be placed at most once per paper trade. Pinned by `"a pending order found in history is recorded, not placed again"` in Task 7.
4. **Name on screen not matching the model called:** the arena must show the model id the provider actually served. Pinned by `"verify fails when the served model differs from the roster"` in Task 5.
5. **Early hours with few trades:** with zero trades, or one model idle, the page shows empty states and never says "outperform" about an idle model. Pinned by `"live arena with no trades is empty, not sample"` in Task 6.

## Before you start (people, not code)

Do these in parallel with Tasks 1–4. Task 5's `pnpm verify:arena` checks each one.

- [x] **API keys** in the root `.env`: `LLM_API_KEY` (Anthropic), `OPENAI_API_KEY`, `GEMINI_API_KEY` (Google), `DEEPSEEK_API_KEY`. Still missing: `XAI_API_KEY` (Avi has one); until it is set, Grok is left out of the arena. Copy all of them to Railway in Task 9.
- [ ] **Five Gemini sandbox accounts** (needed only for Milestone B) in one sandbox account group on exchange.sandbox.gemini.com (the SDK's `account.createNewAccount` can create them with a master key). For each account: an **account-level** API key (it starts with `account-`; a master key fails with `MissingAccounts`) with the Trader role and "Uses a time based nonce"; accept the prediction market terms in the sandbox web interface; give the account test USD.
- [ ] Put the five keys in `.env` and on Railway as one JSON value: `GEMINI_AGENT_KEYS={"arena-claude":{"apiKey":"account-…","apiSecret":"…"},"arena-grok":{…},…}`.

---

### Task 1: The arena roster, shared by worker and web

**Files:**
- Create: `packages/core/src/arena.ts`
- Modify: `packages/core/src/index.ts` (export it), `packages/core/src/browser.ts` (export it; the web's client components import from `@thesis/core/browser`)
- Modify: `apps/web/lib/arena-view.ts` (take `ModelId` and display names from the roster; keep `logo` and `color` here; drop Qwen)
- Modify: `apps/web/lib/arena-mock.ts` (drop Qwen's behaviour), `apps/web/components/arena-panel.tsx` (README.txt counts models from the roster instead of saying "Six")
- Delete: `apps/web/public/models/qwen.svg`
- Test: `packages/core/test/arena.test.ts`

**Interfaces:**
- Produces: `type ModelId = 'gemini' | 'claude' | 'gpt' | 'grok' | 'deepseek'`; `type ArenaProvider = 'anthropic' | 'deepseek' | 'openai' | 'xai' | 'google'`; `interface ArenaEntrant { id: ModelId; agentKey: \`arena-${ModelId}\`; displayName: string; provider: ArenaProvider; model: string }`; `const ARENA_ROSTER: readonly ArenaEntrant[]` in the validated colour order gemini, claude, gpt, grok, deepseek (colours #3987e5, #d95926, #199e70, #c98500, #9085e9; this five-slot set passes the palette validator on #18181a); `const ARENA_STRATEGY: string` (the one strategy summary every entrant shares); `arenaEntrant(agentKey: string): ArenaEntrant | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
it('lists five entrants in the validated colour order, each its own agent', () => {
  expect(ARENA_ROSTER.map((e) => e.id)).toEqual(['gemini', 'claude', 'gpt', 'grok', 'deepseek']);
  expect(new Set(ARENA_ROSTER.map((e) => e.agentKey)).size).toBe(5);
  for (const e of ARENA_ROSTER) expect(e.agentKey).toBe(`arena-${e.id}`);
  expect(arenaEntrant('arena-claude')?.provider).toBe('anthropic');
  expect(arenaEntrant('news')).toBeUndefined();
});
```

- [ ] **Step 2: Run it and see it fail** — `corepack pnpm exec vitest run packages/core/test/arena.test.ts` → FAIL, module not found.
- [ ] **Step 3: Implement `packages/core/src/arena.ts`.** Starting model ids (Task 5's verify script confirms or corrects each one; the display name must always name the model id it holds):

| id | displayName | provider | model |
| --- | --- | --- | --- |
| gemini | from the confirmed id, e.g. Gemini 2.5 Pro | google | `gemini-2.5-pro` (use a newer one if `verify:arena` lists it with search) |
| claude | Claude Sonnet 5.5 | anthropic | `claude-sonnet-5-5` (what the worker already runs) |
| gpt | from the confirmed id, e.g. GPT-5 | openai | `gpt-5` |
| grok | Grok 4.7 | xai | `grok-4.7` (verified live on Avi's branch) |
| deepseek | from the confirmed id, e.g. DeepSeek V3.1 | deepseek | the DeepSeek model that supports `deepseek_web_search` (their docs show `deepseek-flash`) |

- [ ] **Step 4: Make `apps/web/lib/arena-view.ts` read names from the roster:** `ARENA_MODELS` keeps `logo` and `color` per `ModelId` and takes `name` from `ARENA_ROSTER`. The mock keeps working.
- [ ] **Step 5: Run the core and web tests** — `corepack pnpm exec vitest run packages/core/test/arena.test.ts apps/web/test/arena.test.ts` → PASS.
- [ ] **Step 6: Commit** — `git commit -m "Arena roster: five model entrants shared by worker and web"`

---

### Task 2: Per-model spend caps that never touch the auditor's budget

**Files:**
- Modify: `packages/db/src/queries/theses.ts:172` (`llmTokensSince`)
- Modify: `apps/worker/src/llm/index.ts` (`withSpendCap`)
- Test: `apps/worker/test/llm-cap.test.ts`

**Interfaces:**
- Produces: `llmTokensSince(db: Db, since: Date, scope?: { purposePrefix?: string; excludePrefix?: string }): Promise<number>`; `withSpendCap(db, provider, options: { dailyTokenCap: number; logger: Logger; purposePrefix?: string; excludePrefix?: string; now?: () => Date }): Llm`. Arena calls use purpose `arena:<id>`; the auditor and News keep their purposes and pass `excludePrefix: 'arena:'`.

- [ ] **Step 1: Write the failing tests**

```ts
it("arena calls never count against the auditor's cap", async () => {
  await recordLlmCall(db, { purpose: 'arena:gpt', model: 'gpt-5', inputTokens: 900, outputTokens: 0 });
  const auditor = withSpendCap(db, fakeProvider(), { dailyTokenCap: 1000, excludePrefix: 'arena:', logger });
  await expect(auditor.generateJson(args('audit-screen'))).resolves.toBeDefined();
});
it('a model at its own cap is refused while the others continue', async () => {
  await recordLlmCall(db, { purpose: 'arena:gpt', model: 'gpt-5', inputTokens: 500, outputTokens: 0 });
  const gpt = withSpendCap(db, fakeProvider(), { dailyTokenCap: 500, purposePrefix: 'arena:gpt', logger });
  const claude = withSpendCap(db, fakeProvider(), { dailyTokenCap: 500, purposePrefix: 'arena:claude', logger });
  await expect(gpt.generateJson(args('arena:gpt'))).rejects.toMatchObject({ code: 'budget' });
  await expect(claude.generateJson(args('arena:claude'))).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run and see both fail** — `corepack pnpm exec vitest run apps/worker/test/llm-cap.test.ts`.
- [ ] **Step 3: Implement the scoped sum** (`purpose like '<prefix>%'` / `not like`) and pass `scope` through `withSpendCap`. In `apps/worker/src/index.ts`, give the auditor's and News's `withSpendCap` calls `excludePrefix: 'arena:'`.
- [ ] **Step 4: Run the tests and the existing worker suite** — `corepack pnpm exec vitest run apps/worker/test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Spend caps per arena model, apart from the auditor's"`

---

### Task 3: Provider adapters for all five models

Three adapters cover five models, because several providers speak the same API.

**Files:**
- Modify: `apps/worker/src/llm/anthropic.ts` (accept `baseUrl` and `searchTool` options) → Claude, and DeepSeek through its Anthropic-compatible endpoint
- Create: `apps/worker/src/llm/responses.ts` (OpenAI-style Responses API) → GPT (`https://api.openai.com/v1`), Grok (`https://api.x.ai/v1`)
- Create: `apps/worker/src/llm/google.ts` (Gemini `generateContent` with the `google_search` tool) → Gemini
- Modify: `packages/core/src/llm.ts` (optional `LlmCompletion.searchSuggestionsHtml?: string`; optional `GenerateJsonArgs.onCompletion?: (c: LlmCompletion) => void`, called by `createLlm` after a valid result)
- Test: `apps/worker/test/llm-responses.test.ts`, `apps/worker/test/llm-google.test.ts`, `apps/worker/test/llm-anthropic.test.ts` (new; the adapter has no test today)

**Interfaces:**
- Consumes: `LlmProvider`, `LlmRequest`, `LlmCompletion`, `LlmError` from `@thesis/core`.
- Produces: `createResponsesProvider(o: { baseUrl: string; apiKey: string; model: string; fetch?: typeof fetch }): LlmProvider`; `createGoogleProvider(o: { apiKey: string; model: string; fetch?: typeof fetch }): LlmProvider`; `createAnthropicProvider(o: AnthropicProviderOptions & { baseUrl?: string; searchTool?: Record<string, unknown> })`.

Behaviour every adapter shares, in the style of `anthropic.ts`: `useSearch` adds the provider's hosted search tool and nothing else; the reply text and token usage come back as `LlmCompletion`, with `model` set to the model the provider says it served; 401/403 and "insufficient credit" map to `LlmError('unavailable')`, 429 and 5xx to `'provider'`, an abort past `timeoutMs` to `'timeout'`, and a refusal to `'refused'`. An error message never includes the API key or the request body.

- [ ] **Step 1: Write the failing tests** with an injected fake `fetch`. For `responses.ts`: `'sends the web_search tool only when asked'`, `'returns output_text and usage input_tokens/output_tokens'`, `'asks for the json_schema text format'`, `'maps 401 to unavailable and 429 to provider'`, `'never puts the key in an error message'`. For `google.ts`: `'sends tools: [{ google_search: {} }] when asked'`, `'reads usageMetadata.promptTokenCount and candidatesTokenCount'`, `'returns groundingMetadata.searchEntryPoint.renderedContent as searchSuggestionsHtml'`. For the Anthropic adapter: `'uses baseUrl and searchTool when given'`.
- [ ] **Step 2: Run and see them fail** — `corepack pnpm exec vitest run apps/worker/test/llm-responses.test.ts apps/worker/test/llm-google.test.ts`.
- [ ] **Step 3: Implement.** Responses API: `POST {baseUrl}/responses` with `{ model, instructions: system, input: user, tools?: [{ type: 'web_search' }], text?: { format: { type: 'json_schema', name: 'reply', schema, strict: true } } }`; the text is the concatenated `output[].content[].text` of type `output_text`. Google: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `x-goog-api-key`, `systemInstruction`, `contents`, `tools: [{ google_search: {} }]`; rely on the core JSON rule for shape (do not send `responseSchema` together with search). DeepSeek: `createAnthropicProvider({ baseUrl: 'https://api.deepseek.com/anthropic', searchTool: { type: 'deepseek_web_search', name: 'deepseek_web_search' } })`; confirm both values against https://api-docs.deepseek.com/guides/web_tools before relying on them.
- [ ] **Step 4: Run the adapter tests** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Model adapters: Responses API (GPT, Grok), Gemini with Google Search, DeepSeek via Anthropic API"`

---

### Task 4: The arena cycle: one market, one prompt, independent decisions

**Files:**
- Create: `apps/worker/src/agent-kit.ts` (move, unchanged, from `agents.ts`: `NEWS_SYSTEM`, `NewsEstimateSchema`, `describeMarket`, `openMarkets`, `lastLooks`, `marketsWithThesis`, `isHalted`, `logRun`, `submit`; `agents.ts` imports them back)
- Create: `apps/worker/src/arena.ts`
- Test: `apps/worker/test/arena.test.ts` (reuse the fixtures style of `apps/worker/test/agents.test.ts`)

**Interfaces:**
- Consumes: `ARENA_ROSTER`, `ARENA_STRATEGY` (Task 1); an `Llm` per entrant (Tasks 2–3); `decideNews` (core); `ensureAgentAuthor`, `countAuditingTheses` (db).
- Produces: `interface ArenaContender { entrant: ArenaEntrant; llm: Llm }`; `runArenaCycle(deps: { db: Db; contenders: ArenaContender[]; tradingEnabled: () => boolean; logger: Logger; now?: () => Date }): Promise<{ market: string | null; results: Array<{ id: ModelId; decision: 'trade' | 'skip'; reason: string }> }>`.

Market choice: among markets eligible under the News rules (non-short contract, ≥ 1 hour left, two-sided book), the one any arena agent looked at least recently. Every contender then gets exactly that market and the identical `user` prompt; each call uses purpose `arena:<id>` and runs in parallel under `Promise.allSettled`. Each contender's own author, halt state, pending-audit check and "already holds this market" check apply only to it. A trade is submitted with `submit` under that contender's author; the cycle captures `searchSuggestionsHtml` through `onCompletion` and stores it in the run's `signal`.

- [ ] **Step 1: Write the failing tests**

```ts
it('asks every model about the same market with the identical prompt', async () => {
  const seen: string[] = [];
  const contenders = ARENA_ROSTER.map((entrant) => ({ entrant, llm: fakeLlm({ probability_yes: 0.5 }, (args) => seen.push(args.user)) }));
  const out = await runArenaCycle({ db, contenders, tradingEnabled: () => true, logger });
  expect(new Set(seen).size).toBe(1);
  expect(out.results).toHaveLength(ARENA_ROSTER.length);
});
it('a model with enough edge trades under its own author', async () => { /* gpt says 0.9 on a 0.6 market */
  expect(await thesisAuthorKeys(db)).toEqual(['arena-gpt']);
});
it('one model failing does not stop the others', async () => { /* grok throws LlmError('provider'); claude says 0.9 */
  expect(results.find((r) => r.id === 'grok')).toMatchObject({ decision: 'skip' });
  expect(await thesisAuthorKeys(db)).toContain('arena-claude');
});
it('a model refused by its budget logs a budget skip', async () => { /* gpt's llm throws LlmError('budget') */
  expect(results.find((r) => r.id === 'gpt')).toMatchObject({ decision: 'skip', reason: expect.stringContaining('daily') });
  expect(await thesisAuthorKeys(db)).not.toContain('arena-gpt');
});
it('five consecutive errors halt only that model', async () => { /* run 5 cycles with grok failing */
  expect(await haltedKeys(db)).toEqual(['arena-grok']);
});
```

- [ ] **Step 2: Run and see them fail** — `corepack pnpm exec vitest run apps/worker/test/arena.test.ts`.
- [ ] **Step 3: Move the shared helpers into `agent-kit.ts`, then implement `runArenaCycle`.** The consecutive-error halt writes `agent_state.halted` with reason `'consecutive model errors'` for that agent key only, mirroring Avi's branch (`apps/worker/src/news-observer.ts` on `origin/avi/ubc-hack`).
- [ ] **Step 4: Run the arena tests and the existing agent tests** — `corepack pnpm exec vitest run apps/worker/test/arena.test.ts apps/worker/test/agents.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Arena cycle: every model, one market, one prompt, independent trades"`

---

### Task 5: Wire the arena into the worker, and a verify script that gates go-live

**Files:**
- Modify: `apps/worker/src/env.ts` (add `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`; Claude keeps using `LLM_API_KEY`; `ARENA_INTERVAL_MINUTES` default 60 min 15, `ARENA_DAILY_TOKEN_CAP_PER_MODEL` default 300000; `ENABLED_AGENTS` accepts `arena` and defaults to `arena`)
- Create: `apps/worker/src/arena-contenders.ts`
- Modify: `apps/worker/src/index.ts` (schedule `runArenaCycle` every `ARENA_INTERVAL_MINUTES`, first run after 60 s)
- Create: `apps/worker/src/verify-arena.ts`; add `"verify:arena": "tsx src/verify-arena.ts"` to `apps/worker/package.json`
- Test: `apps/worker/test/arena-contenders.test.ts`

**Interfaces:**
- Produces: `createArenaContenders(env: WorkerEnv, db: Db, logger: Logger, make?: ProviderFactory): ArenaContender[]` (an entrant without its key is left out and named in one log line); `checkServedModel(entrant: ArenaEntrant, served: string): { ok: true } | { ok: false; message: string }` (ok when `served` equals or starts with `entrant.model`).

- [ ] **Step 1: Write the failing tests**

```ts
it('leaves out entrants without a key, and says which', () => {
  const contenders = createArenaContenders({ ...env, OPENAI_API_KEY: undefined }, db, logger, fakeFactory);
  expect(contenders.map((c) => c.entrant.id)).not.toContain('gpt');
  expect(logs.join('\n')).toContain('gpt');
});
it('verify fails when the served model differs from the roster', () => {
  expect(checkServedModel(entrant('gpt'), 'gpt-5-mini')).toMatchObject({ ok: false });
  expect(checkServedModel(entrant('gpt'), 'gpt-5-2025-08-07')).toEqual({ ok: true });
});
```

- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.** `verify-arena.ts` makes one search call per configured entrant (purpose `arena-verify:<id>`, counted in `llm_calls`), prints the served model and whether it searched, then, for each `GEMINI_AGENT_KEYS` entry, prints terms status (`predictions.getPredictionMarketsTermsStatus`) and available USD (`account.getAvailableBalances`). It exits 1 when any configured entrant or account fails. It never prints a key.
- [ ] **Step 4: Run the tests** → PASS. Then run `corepack pnpm --filter @thesis/worker verify:arena` with real keys. Expected: an `ok` row for every model whose key is set (Grok shows "not configured" until `XAI_API_KEY` is added) and, once `GEMINI_AGENT_KEYS` exists, each account with terms accepted and USD > 0. Fix any roster model id it reports, re-run.
- [ ] **Step 5: Commit** — `git commit -m "Run the arena in the worker; verify:arena checks every model and sandbox account"`

---

### Task 6: `/arena` from real trades

**Files:**
- Create: `apps/web/lib/ledger.ts` (move the pricing and equity functions out of `apps/web/lib/race.ts`: `histories`, `pricer`, `equityAt`; `race.ts` imports them, its tests stay green)
- Create: `packages/db/src/queries/arena.ts` (`getArenaData`: `getRaceData` for every roster agent key plus the last 12 `agent_runs` per key and each author's `walletAddress`); export it from `packages/db/src/index.ts`
- Create: `apps/web/lib/arena.ts` (`buildArena`)
- Modify: `apps/web/lib/arena-data.ts` (`ARENA_SOURCE=live` → `getArenaData` + `buildArena`; otherwise the sample)
- Modify: `apps/web/lib/arena-view.ts` (`ArenaMessage.searchSuggestionsHtml?: string`; `ArenaStanding.walletAddress?: string`)
- Modify: `apps/web/components/arena-panel.tsx` (render `searchSuggestionsHtml` under that message in `<iframe sandbox="" srcDoc=…>`, as Google's terms require; list each model's wallet with an explorer link in README.txt)
- Test: `apps/web/test/arena-live.test.ts`, `packages/db/test/arena.test.ts`

**Interfaces:**
- Consumes: `RaceData`-shaped rows (`getRaceData`), `ARENA_ROSTER`.
- Produces: `interface ArenaData extends RaceData { runs: Map<string, Array<RaceRun & { thesisHeadline: string | null; searchSuggestionsHtml: string | null }>>; wallets: Map<string, string | null> }` (both maps keyed by agent key); `getArenaData(db: Db, opts: { now: Date; slots: number; runsPerAgent: number }): Promise<ArenaData>`; `buildArena(data: ArenaData, opts: { now: Date; bankrollUsd: number }): ArenaResponse` with `sample: false`.

Mapping: standings and `points` from each model's equity; `trades` = its settled positions (exit 1 if the side won, 0 if it lost, the stake back if void); `positions` = its open positions at the current midpoint; `messages` = its `agent_runs` reasons, newest first, with the thesis headline when the run traded; `matchup` follows the mock's rule (leader must have traded and be ahead; the deal is the market where it gained most on the trailer).

- [ ] **Step 1: Write the failing tests**

```ts
it('live arena with no trades is empty, not sample', () => {
  const a = buildArena(emptyData(), { now: NOW, bankrollUsd: 1000 });
  expect(a.sample).toBe(false);
  expect(a.points).toEqual([]);
  expect(a.matchup).toBeNull();
  expect(a.standings.every((s) => s.valueUsd === 1000)).toBe(true);
});
it('counts each model on its own ledger', () => { /* gpt: 10 YES at 0.50, mid now 0.65; claude: settled, paid $10 on $5 */
  expect(standing(a, 'gpt').valueUsd).toBe(1001.5);
  expect(standing(a, 'claude').valueUsd).toBe(1005);
  expect(standing(a, 'grok').valueUsd).toBe(1000);
});
it('never says an idle model outperforms', () => { /* only gpt traded and lost */
  expect(a.matchup?.headline ?? '').not.toMatch(/^Watch Claude/);
});
it('turns agent runs into model chat, newest first', () => { /* runs at 10:00 and 11:00 */
  expect(a.messages.map((m) => m.at)).toEqual([at('11:00'), at('10:00')]);
});
```

- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement**, reusing `ledger.ts` so the race page and the arena value positions the same way.
- [ ] **Step 4: Run** `corepack pnpm exec vitest run apps/web/test packages/db/test` → PASS, and `corepack pnpm --filter @thesis/web typecheck` → exit 0.
- [ ] **Step 5: Commit** — `git commit -m "Arena from real trades when ARENA_SOURCE=live"`

**Milestone A ends here:** every configured model trading on paper with their own ledgers and payout wallets, shown live on `/arena`. Deploy it (Task 9) before starting Milestone B.

---

### Task 7: Sandbox mirror: each paper trade as a real order from the model's own account

**Files:**
- Modify: `packages/db/src/schema.ts` (table `sandbox_orders`), generate migration `0008`
- Create: `apps/worker/src/sandbox-account.ts` (the SDK wrapper)
- Create: `apps/worker/src/sandbox-mirror.ts`
- Modify: `apps/worker/src/env.ts` (`GEMINI_AGENT_KEYS`: JSON map of agent key → `{ apiKey, apiSecret }`, validated with zod), `apps/worker/src/index.ts` (run the mirror every 10 s when any account is configured)
- Test: `apps/worker/test/sandbox-mirror.test.ts`

**Interfaces:**
- Produces: table `sandbox_orders(trade_id uuid pk → trades.id, agent_key text, client_order_id text unique, status 'pending'|'filled'|'partial'|'unfilled'|'failed', order_id text, sandbox_price numeric, filled_quantity numeric, error_code text, created_at, updated_at)`; `interface SandboxAccount { ask(symbol: string, side: 'yes' | 'no'): Promise<string | null>; place(o: { symbol: string; side: 'yes' | 'no'; quantity: string; price: string; clientOrderId: string }): Promise<{ orderId: string; filledQuantity: string; avgPrice: string | null }>; findByClientOrderId(id: string): Promise<{ orderId: string; filledQuantity: string; avgPrice: string | null } | null> }`; `createSandboxAccount(keys: { apiKey: string; apiSecret: string }): Promise<SandboxAccount>` (`createClient({ env: 'sandbox', auth: new HmacAuth({ apiKey, apiSecret, nonceMode: 'time-based' }) })`; orders are `orderType: 'limit'`, `side: 'buy'`, `outcome`, `timeInForce: 'immediate-or-cancel'`, `makerOrCancel: false`, and for NO the price is the NO price); `createSandboxMirror(deps: { db: Db; accounts: Map<string, SandboxAccount>; logger: Logger }): { runCycle(): Promise<{ placed: number; recorded: number; waiting: number }> }`.

Rules: mirror only arena agents' own filled positions (`is_author_position`, agent key `arena-*`) created after the mirror first ran. Claim the trade by inserting a `pending` row before calling the sandbox; `clientOrderId` is the trade id. Price is the sandbox's own ask for that side at order time (crossing the sandbox book; its price is recorded beside the paper price, never used for the score). No ask → `unfilled`; no account for the agent → `failed` with `no_sandbox_account`; a network error leaves `pending` for the next cycle, which first looks the order up by `clientOrderId`.

- [ ] **Step 1: Write the failing tests**

```ts
it('places one IOC order per arena trade from that model\'s account, at the sandbox ask', async () => {
  expect(fake('arena-gpt').placed).toEqual([{ symbol: SYMBOL, side: 'yes', quantity: '10', price: '0.55', clientOrderId: trade.id }]);
  expect(await row(trade.id)).toMatchObject({ status: 'filled', sandboxPrice: '0.5500' });
});
it('a pending order found in history is recorded, not placed again', async () => { /* pending row + history hit */
  expect(fake('arena-gpt').placed).toEqual([]);
  expect(await row(trade.id)).toMatchObject({ status: 'filled' });
});
it('leaves people\'s trades and copies alone', async () => { /* human author trade, copier trade */
  expect(await allRows()).toEqual([]);
});
it('records unfilled when the sandbox has no seller', async () => { /* ask() returns null */
  expect(await row(trade.id)).toMatchObject({ status: 'unfilled' });
  expect(fake('arena-gpt').placed).toEqual([]);
});
it('records failed without retrying when the model has no sandbox account', async () => { /* two cycles */
  expect(await row(trade.id)).toMatchObject({ status: 'failed', errorCode: 'no_sandbox_account' });
});
it('keeps a trade pending through a network error and retries it', async () => { /* place() throws once */
  expect(await row(trade.id)).toMatchObject({ status: 'filled' });
  expect(fake('arena-gpt').placed).toHaveLength(1);
});
```

- [ ] **Step 2: Run and see them fail** — `corepack pnpm exec vitest run apps/worker/test/sandbox-mirror.test.ts`.
- [ ] **Step 3: Add the table, run `corepack pnpm db:generate`, check the generated `0008_*.sql` only creates `sandbox_orders`, then implement the account wrapper and the mirror.** At start-up, log (without keys) any account whose prediction market terms are not accepted; do not accept them in code.
- [ ] **Step 4: Run the mirror tests and the full worker suite** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "Mirror arena trades as real orders from each model's Gemini sandbox account"`

---

### Task 8: Show the sandbox orders on `/arena`

**Files:**
- Modify: `packages/db/src/queries/arena.ts` (join `sandbox_orders` onto each position and trade)
- Modify: `apps/web/lib/arena-view.ts` (`ArenaPosition.exchange` and `ArenaTrade.exchange`: `{ status: 'pending' | 'filled' | 'partial' | 'unfilled' | 'failed'; quantity: number | null; price: number | null } | null`)
- Modify: `apps/web/lib/arena.ts`, `apps/web/components/arena-panel.tsx` (one muted line under each position and trade: "Sandbox order filled, 10 at 55¢", "Sandbox order not filled", "Sandbox order pending"); README.txt gains one paragraph: account value is the paper ledger at Gemini's live prices; each trade is also placed from the model's own sandbox account, whose bot-driven prices do not count.
- Test: extend `apps/web/test/arena-live.test.ts`

- [ ] **Step 1: Write the failing test** `'carries each trade\'s sandbox order status'` (a filled, an unfilled and a missing mirror row map to `filled`, `unfilled` and `null`).
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm exec vitest run apps/web/test` → PASS; `corepack pnpm --filter @thesis/web typecheck` → exit 0.
- [ ] **Step 5: Commit** — `git commit -m "Arena shows each trade's sandbox order"`

**Milestone B ends here.**

---

### Task 9: Go live (run after Milestone A, and again after Milestone B)

No new code; each step has a check.

- [ ] **Step 1:** On Railway set `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY` and `XAI_API_KEY` (once Avi provides it), `ENABLED_AGENTS=arena`, `ARENA_INTERVAL_MINUTES=60`, `ARENA_DAILY_TOKEN_CAP_PER_MODEL=300000` (and `GEMINI_AGENT_KEYS` for Milestone B). On Vercel set `ARENA_SOURCE=live`.
- [ ] **Step 2:** Deploy: `railway up` (the worker applies migration `0008` on start) and `vercel deploy --prod`. Check: `railway logs` shows `worker started` with `arena` in its jobs and the contenders it found.
- [ ] **Step 3:** Within the first cycle (about a minute), `select agent_key, decision, reason from agent_runs where agent_key like 'arena-%' order by created_at desc limit 12;` shows one row per configured model.
- [ ] **Step 4:** Within a few cycles, a trade appears: its thesis is `published` with a `register_tx`, the author has a `wallet_address`, and `/arena` shows it under Positions. With Milestone B, a `sandbox_orders` row follows within 10 seconds.
- [ ] **Step 5:** `/arena` no longer shows "Sample data", and the home card names two real models.

## Optional, after both milestones

- **Citation provenance:** port Avi's rule that every cited URL must appear in the search results the provider returned (`apps/worker/src/xai-research.ts` and `news.ts` on `origin/avi/ubc-hack`), using `onCompletion` to pass the provider's source list.
- **A no-model baseline line:** Avi's BTC 15-minute agent (`apps/worker/src/momentum.ts` on his branch), drawn dashed like "BTC buy & hold" in the reference.
