# Phase 5: public records and account controls

November 19, 2026 · branch `avi/ubc-hack`.

## Delivered

- `/leaderboard`: public author rankings by Brier score or realized simulated profit, with resolved counts, void counts and small-sample context. Verification accounts are excluded.
- `/authors/[id]`: the author's public record, strategy summary, a link to agent controls when relevant and cursor-paginated public theses. Private drafts, blocked submissions and auditing jobs are never included.
- `/me`: the current guest's simulated balance, UTC spending, remaining allowance, live test-wallet balance/allowance, recent positions, submitted theses including private ones, and tip receipts with actual explorer links. Positions, submissions and tips are bounded to the most recent 50 each.
- `/api/me/limits`: authenticated, same-origin, rate-limited cap changes. Reductions take effect immediately; increases start at the next 00:00 UTC. Hard ceilings remain $10 per trade and $25 per day. Saving active values cancels pending increases.
- `/how-it-works`: a short walkthrough and explicit explanations of live data, simulated fills, actual testnet tips, custody, trusted resolution, audits, record scoring, limits and guest access.
- Shared navigation links and an expandable activity strip backed by completed escrow payouts/refunds. Multiple tips sharing one contract payment are aggregated before the result limit, so the displayed pool amount is complete.
- Market disagreement bars show AI, human and market YES probabilities, with group counts and honest empty states. Verification forecasts remain labeled on their public markers but do not affect group averages.
- Thesis cards link to author profiles and show the author's resolved count and Brier score. Integration verification accounts are labeled in the feed, thesis view, profile and activity strip.

## Scoring and money semantics

Brier is the mean of `(forecast YES probability − official YES outcome)²`; a constant 50% forecast scores 0.250. Only public resolved theses with an official YES/NO result count. Open and void theses are excluded. Market comparison uses the author's probability and market YES price recorded at publication on **the identical subset of theses**; its separate count is displayed when historical market prices are missing.

Profit sums settled **author paper positions**, using exact decimal arithmetic. It excludes copier positions, open positions and all test-USDC tips. Position aggregation precedes the author join, so joins cannot multiply forecast counts or profit. Rank ordering for money uses integer decimal units. Rankings show the available sample rather than implying a statistically established advantage.

`authors.is_test` is server-managed. Known Phase 3 and Phase 4 integration authors were classified using their existing verification journals and the recorded Phase 3 acceptance thesis ID. The helper does not infer test status from names or user text. New real human accounts default to non-test; public rankings still require published resolved evidence. No fabricated human opinions or fixture trades were inserted into the local product database for this phase.

## Limits and privacy

Migration `0006_tidy_ironclad.sql` adds pending caps/effective time on users, the author verification flag and an escrow settlement timestamp. `0007_windy_stranger.sql` adds the owner/time index used by recent tip history. There are still 19 application tables; existing RLS remains enabled. No remote database was migrated. UTC spending is aggregated in Postgres rather than transferring all of today's trades to the web process.

Effective limits are computed in the account API, quote service, copy confirmation and human paper executor. Applying a scheduled raise does not depend on a scheduled job or an account-page visit. At the exact UTC boundary all four paths observe the new limits. A later change first incorporates any due values. Copy confirmation rechecks caps under the same user row lock used to change them, so lowering a cap after a quote prevents an oversized fill. Daily accounting still includes filled and settled paper positions and resets at UTC midnight.

Private account data comes only from the signed session's user ID. The API accepts no caller-supplied owner override. Public author profiles do not include user IDs, Circle wallet IDs, balances, private drafts or copy histories. A failed account read shows a retry; it does not silently create another session. The guest-start form appears only after a confirmed missing/expired session. Guest access lasts seven days and has no recovery flow.

Test-wallet balances are queried separately so a Circle/RPC outage does not hide paper history. On-chain balance is distinct from balance reserved by pending tips. A failed tip never reverses its already committed paper position.

## Verification

Verification uses the existing local Postgres database and a production Next.js preview at `http://127.0.0.1:3100`. Chrome runs headlessly; no user screen is controlled. The browser helper creates an unfunded guest and changes paper caps, without placing trades, creating a Circle wallet or sending USDC.

```powershell
corepack pnpm db:migrate
node --import tsx scripts/verify-live-copy.ts classify
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build:web
node scripts/verify-phase5-ui.mjs
```

The `classify` mode updates only the known local acceptance accounts and refuses a remote database. Browser verification requires installed Chrome and the existing local Playwright tools under ignored `.local/browser-tools`. Run against a started production preview, after restarting it to load the current build.

Tests cover hand-computed YES/NO scoring, matching market samples, private/open/void exclusions, copy/tip profit isolation, complete aggregate activity, verification-account exclusions, owner-only account history, immediate reductions, delayed/cancelled increases, exact UTC activation and confirmation-time enforcement. Headless checks cover desktop and 390/320-pixel pages, guest onboarding, real limit changes, owner receipt visibility, cross-origin and unauthenticated rejection, retained ranking data during a failed read, recovery on retry and actual transaction links.

The full suite passed **242 tests across 25 files**. All six TypeScript projects and the production Next.js build passed. The headless run passed nine check groups, including 1440-, 390- and 320-pixel layouts, with zero browser errors. See [the validation summary](evidence/phase5-validation.json), [browser report](evidence/phase5-ui.json) and [two-connection PostgreSQL check](evidence/phase5-concurrency.json). These contain no session cookies, credentials or recovery data.

![Public records on a phone](images/phase5-records-mobile.png)

![Immediate caps and a scheduled increase](images/phase5-limits-mobile.png)

![Public author record](images/phase5-author-mobile.png)

## Acceptance still requiring human or hosted work

The build plan asks the team to write at least five **genuine human theses**. These require the team's own views and sources; automated verification forecasts do not satisfy that item. Their content was requested while construction continued, and has not been supplied. A timed fresh-visitor copy rehearsal against a qualifying open book also remains a demo acceptance item; layout checks do not claim that timed rehearsal passed.

Phase 4's live correct-author payout remains pending a qualifying market and official outcome. A real incorrect-thesis refund is already verified, and correct-author payouts pass contract/service tests. The Arc contract's public source verification is confirmed. Always-on hosted acceptance, news execution, the extension, demo recording and submission materials remain subsequent work. News remains disabled and paper mode remains enforced.
