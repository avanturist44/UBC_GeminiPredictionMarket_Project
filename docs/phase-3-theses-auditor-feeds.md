# Phase 3: theses, auditor and feeds

Updated November 18, 2026 (Pacific). Branch: `avi/ubc-hack`.

## Delivered

The AI and Human feeds now show published theses instead of placeholders. Visitors can open a thesis, inspect its evidence and audit, and see the locked paper position and official outcome. The new `/write` form creates a guest session, submits an immutable thesis, and follows its private audit/publication status automatically.

The core Phase 3 acceptance path is verified: the AI feed displays audit results; the guest-author publishing path produces a paper fill and public thesis; inside-information content is blocked privately without a trade; and a live Grok audit flags a false factual claim. The publishing example was submitted by an explicitly named **Automated publication verification** guest. It demonstrates the user workflow, not a human-authored forecast or strategy performance.

News research remains log-only and scheduling remains disabled in the BTC supervisor. News execution and the optional fade strategy are not included in this milestone. Circle wallets, USDC escrow, registration and copy trading remain Phase 4 work. No hosted service was deployed or hosted database changed.

## User flow

1. Open the AI feed (`/`) or Human feed (`/humans`). Cards show the author, market, forecast, entry/current YES price, outcome and audit status. Agent filters and cursor pagination are supported. Reads refresh every five seconds.
2. Select **Write a thesis**. A new guest starts with $1,000 simulated dollars. Submit a market, side, YES probability, $1–$10 stake, headline, reasoning and public HTTPS evidence.
3. Explicit inside-information claims are blocked by a conservative keyword preflight. Other submissions enter the durable audit queue and remain private to their signed session.
4. A separate worker requests a bounded Grok web audit. It extracts up to six factual claims, checks public sources, and records supported, unsupported, contradicted or unverifiable findings. Predictions and opinions are not factual claims.
5. Blocked results cannot trade. Pass/flagged results proceed to a new official metadata fetch and live Gemini book subscription. Code checks eligibility, age, spread, side, size and account limits before atomically filling and publishing.
6. The position stays locked until Gemini supplies an official YES/NO or invalid outcome. Paper settlement credits the guest balance once. No USDC moves.

Flagged theses can publish with their warnings; they are never labeled as verified. Author-provided evidence is shown separately from the auditor's retrieved sources.

## Audit boundaries

- Verdicts are derived in code. Inside-information/prohibited-content output blocks; any unsupported, contradicted or unverifiable claim flags; otherwise the result passes.
- Non-blocked model audits require a completed web search and strict schema-valid final output. Unsupported fields, refusals and incomplete responses fail closed.
- A source URL is retained only if it is public HTTPS and appears in provider citation metadata. Generated URLs cannot manufacture retrieval provenance. Matching provenance does not establish factual accuracy.
- The final prompt limits extracted claims to exact excerpts from the author's headline, body and evidence claims. Claims invented from application market context cause audit failure. This safeguard was added after the initial live publication audit also evaluated a historical quote supplied as context.
- Fixed BTC numeric templates receive a deterministic code audit inside the same entry transaction for future worker starts. It checks recorded inputs and fill calculations, not forecast profitability, and does not make LLM calls.
- Existing BTC positions are explicitly flagged by `legacy-review-v1` because no contemporaneous audit was recorded. No historical audit is fabricated. The running BTC process was left uninterrupted; it will pick up the new per-entry code audit on its next normal restart/deploy.
- Raw upstream exception bodies and credentials are excluded from persisted publication errors and public API responses. Public pages show concise audit findings, not private model reasoning.

The xAI adapter follows the official [Responses API](https://docs.x.ai/developers/rest-api-reference/inference/responses), [structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs), [web search](https://docs.x.ai/developers/tools/web-search) and [citation metadata](https://docs.x.ai/developers/tools/citations) documentation checked during implementation.

## Session, financial and operational controls

| Control | Behavior |
| --- | --- |
| Guest identity | HMAC-signed, seven-day cookie; HttpOnly, SameSite=Lax, Secure on HTTPS |
| Signing key | At least 32 characters; server-only `SESSION_SECRET` |
| Write requests | Same-origin JSON only; 16 KiB body limit |
| Submission limits | Ten writes/minute and ten new submissions/hour per guest; replaying the same request creates no new work |
| Audit budget | At most 20 queued audit reservations per rolling hour across workers; a singleton database row serializes reservations |
| Model bounds | 90-second timeout, 3 tool calls, 2,500 output tokens; search only |
| Interrupted jobs | Two-minute lease; fail privately without automatic paid retry |
| Stakes | $1–$10 requested paper budget; account per-trade cap also applies |
| Daily spending | $25 default across paper positions created during the UTC day; user balance and limits checked under a user row lock |
| Quotes | Exact symbol, official active/open metadata, at least two minutes left, metadata/book no older than ten seconds, spread at most six cents |
| Size/accounting | Available top-of-book size, official quantity increments/minimums, exact four-decimal money; partial available-size fills allowed |
| Commit guard | Recheck live book, size, UTC day and kill switch before commit; rollback on change |
| Idempotency | One immutable submission UUID and one deterministic human trade key; conflicting payload reuse is rejected |
| Settlement | Exact official contract result; one payout under the user lock; invalid outcomes refund cost |

Guest caps apply to that guest session/account. Guest identity is a demo convenience and does not prevent a person from creating another account by clearing cookies. The worker's global audit cap still bounds queued model requests. The explicit diagnostic CLI tools can make their own metered requests and should be run deliberately.

No automatic retry or cross-thesis audit cache is used: a failed submission requires a new attempt, and time-sensitive facts are not reused from a different thesis. Pending work remains queued if auditing/trading is disabled or the hourly budget is exhausted. Settlement continues independently of the entry kill switch.

## Code and database changes

| Location | Responsibility |
| --- | --- |
| `packages/services/src/audit.ts`, `xai.ts` | Screening, strict audit validation, provenance and xAI adapter |
| `packages/services/src/publication.ts`, `session.ts` | Signed guests, submission validation, durable limits and idempotency |
| `packages/services/src/queue.ts` | Cross-worker audit reservation, lease, private failure and publication orchestration |
| `packages/services/src/human-paper.ts`, `money.ts` | Fresh live quotes, atomic human fills, exact accounting and official settlement |
| `packages/services/src/feed.ts`, `legacy.ts` | Bounded public read models, private owner access and honest legacy audit warnings |
| `apps/worker/src/thesis-worker.ts` | Separate audit/publishing/settlement loop |
| `apps/worker/src/paper.ts` | Deterministic audits for future BTC entries |
| `apps/web/components/thesis-*.tsx` | Feeds, editor, audit panel and thesis detail |
| `apps/web/lib/publication-http.ts` | Same-origin/body validation, cookie reads and safe response errors |
| `scripts/local-worker.ps1 -Worker theses` | Independent local supervisor, heartbeat, archives and crash/stall restart; BTC remains the default |

The database adds `thesis_jobs`, `session_windows` and `audit_control`, with RLS enabled and no public policies, plus indexes for author submission counts and recent audit reservations. There are now 14 application tables. Both new migrations were applied only to local Postgres. Existing market, trade and thesis records were retained.

New endpoints:

| Route | Access |
| --- | --- |
| `GET /api/feed` with `kind=agent` or `kind=human`, optional `agent`/`cursor` | Public; published/resolved only |
| `GET /api/theses/[id]` | Public for published/resolved; signed owner only for private states |
| `POST /api/session` | Same-origin guest creation; an existing session is reused without resetting its balance |
| `GET /api/me` | Signed guest balance, name and spending caps |
| `POST /api/theses` | Signed guest; validates and queues or immediately blocks |

Content hashes are local hashes of recorded content/submission data. They are not on-chain registration or independent proof of a claim. No registration transaction is shown unless one is recorded.

## Verification evidence

### Automated checks

- **216 tests across 22 files passed.** Includes the existing BTC daily-loss stop and new audit schema/provenance, signed-cookie tampering/expiry, private blocked states, immutable retries, quote rollback, balance and spending limits, official winner/void settlement, audit budget and interrupted-job checks.
- Full workspace typecheck passed, including the new services package, web, worker and scripts.
- Production Next.js build passed with the feeds, editor, thesis page and API routes.
- **17 headless Chrome check groups passed** at 1440px, 390px and 320px: all new pages fit, agent filtering works, an editor submission creates a signed session, inside information is blocked privately, replay does not duplicate work, anonymous access returns 404, and cross-origin/oversized writes are rejected. No uncaught browser/hydration errors were recorded. Screenshots were visually inspected.
- Two independent real local Postgres connections were tested in a temporary database: simultaneous duplicate publication produced one fill/debit; concurrent stakes against a shared daily cap allowed one and rejected one; two workers reserved one audit call; concurrent settlement produced one payout/credit. The fixture database was dropped. Its results do not count as live market trades.

### Live audit and publication

At `2026-11-19T00:57:24.867Z` (November 18, 4:57 PM Pacific), the final Grok audit marked **“The Moon is made entirely of cheddar cheese.”** as contradicted, citing [NASA's Moon facts](https://science.nasa.gov/moon/facts/). The explicit inside-information sample was blocked by preflight without a provider call. The false statement was an audit-only test and was not published or traded.

The end-to-end publication checkpoint at `2026-11-19T00:53:14.332Z` (November 18, 4:53 PM Pacific) recorded:

| Evidence | Value |
| --- | --- |
| Guest | Automated publication verification |
| Thesis | `6a03e321-bc1f-4b87-b53f-9e59e1b20e4f` |
| Market | `GEMI-BTC15M2611190100-UP` |
| Requested budget | $1 simulated |
| Fill | 1.4700 YES contracts at $0.6800 |
| Exact cost | $0.9996 simulated |
| Audit | Real Grok 4.7 search audit, flagged; warnings persisted publicly |
| Replay | Same thesis, no second balance debit |
| Registration/USDC | None |

This is a real live-data integration check using simulated funds. The forecast was explicitly labeled as automated verification, and was not produced by the BTC strategy. The first audit included an unverifiable historical quote from context; the final authored-claim safeguard above prevents future audits from inventing that extra claim. Existing audit history is retained.

The BTC worker retained PID `41512` and its original start time throughout. At `2026-11-19T00:58:30.364Z`, its separate checker reported seven qualifying BTC paper trades, seven correct official settlements and zero invalid payouts. Both supervisors were healthy and BTC warmup remained complete.

At `2026-11-19T01:01:58.249Z` (November 18, 5:01 PM Pacific), an independent official-event fetch confirmed **YES** for the guest verification contract. The thesis resolved **Right**, paying **$1.4700 simulated** against its $0.9996 cost. The guest balance became **$1,000.4704**. Replaying the human settlement resolver returned zero settlements and left that balance unchanged. This is accounting evidence for one automated verification position, not a strategy-performance result.

### Screenshots

![AI feed on a phone](images/phase3-feed-mobile.png)

![Thesis editor on a narrow phone](images/phase3-editor-mobile.png)

![The automated guest's settled paper thesis](images/phase3-human-detail-mobile.png)

![AI feed on desktop](images/phase3-feed-desktop.png)

## Run locally

Use the ignored root `.env` with the local `DATABASE_URL`; preserve the separate hosted `PROD_DATABASE_URL`. Existing xAI credentials are server-only.

```dotenv
TRADING_MODE=paper
TRADING_ENABLED=true
THESIS_AUDIT_ENABLED=true
LLM_PROVIDER=xai
LLM_MODEL=grok-4.7
XAI_API_KEY=your-server-only-key
SESSION_SECRET=at-least-32-random-characters
```

The helper below requires a localhost database, generates a signing key if needed, and enables the separate audit worker without printing secrets. It does not change the hosted URL or xAI key:

```powershell
corepack pnpm install
node scripts/setup-local-theses.mjs
corepack pnpm db:migrate
pwsh -NoProfile -File scripts/local-worker.ps1 start -Worker theses
pwsh -NoProfile -File scripts/local-worker.ps1 status -Worker theses
```

The original BTC supervisor continues to use `start`, `status` and `stop` without the `-Worker` option. The thesis supervisor has separate PID/control files and `.local/thesis-worker.*` logs. Stop it with `stop -Worker theses`. Its heartbeat's stream field is a compatibility placeholder; the publication process has no BTC warmup and opens a fresh book per publication.

For a production preview, build from `apps/web`, then start on an unused local port:

```powershell
node node_modules/next/dist/bin/next build
node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3100
```

The current preview uses port 3100 because the old port-3000 development preview had HMR/client-interactivity problems. This milestone verifies production mode; that development-preview issue remains separate.

The final production build was left running at [http://127.0.0.1:3100](http://127.0.0.1:3100) for review. Its temporary process ID is recorded in `.local/phase3-web.pid`, with output/error logs in `.local/phase3-web.*.log`. A final headless smoke check confirmed the AI feed, populated Human feed and resolved guest thesis load without uncaught browser errors. Both independent background worker supervisors remain running.

From the repository root, verification commands are:

```powershell
node node_modules/vitest/vitest.mjs run
corepack pnpm typecheck
node scripts/verify-theses-ui.mjs
node --import tsx scripts/verify-publication-concurrency.ts
node --import tsx scripts/check-human-publication.ts
```

Browser checks need the ignored local `playwright-core` setup described in [the previous verification handoff](verification-2026-11-18.md). Reports/screenshots are under `.local/phase3-ui/`; live results are `.local/live-auditor-result.json`, `.local/live-human-publication.json`, `.local/live-human-settlement.json` and `.local/publication-concurrency.json`.

`verify-theses-ui.mjs` creates a labeled test guest and a private blocked attempt. `verify-auditor.ts` makes one metered Grok audit without a trade. `verify-human-publication.ts` makes a live audit and can publish one explicitly labeled automated thesis with at most a $1 paper budget. Do not count fixture database tests as live acceptance or repeatedly invoke the paid/live tools as routine unit tests.

## Remaining work

1. Phase 4: implement and test the USDC escrow, Circle wallet/funding flow, registrar, copy-trade confirmation and payout/refund resolver. Publish only registered theses when tipping is enabled.
2. Add audited execution for news candidates before enabling news trading. Fade remains deferred under the plan's cut order.
3. Deploy the web, BTC worker and separate thesis worker to the intended hosted database. The thesis service uses `pnpm start:theses`; Railway's existing default `start` continues to run the BTC worker. Recheck hosted health and acceptance.
4. Add the remaining author/leaderboard/account views and collect genuinely human-authored theses for the demo. The automated verification guest does not replace that product requirement.
