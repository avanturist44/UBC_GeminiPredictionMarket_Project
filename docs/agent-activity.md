# Live agent activity

Added November 18, 2026, on `avi/ubc-hack`.

## What changed

The new `/agents` page showcases recorded agent decisions, inputs and evidence. A permanent **Agent activity** header link opens the page, and the AI navigation tab stays selected there. This is an additive page; the home feed is unchanged.

The page reads existing `agent_runs` and market records through the server-only database connection. It refreshes every five seconds through `GET /api/agents/activity`, with uncached responses. Viewing the page does not start agents, request paid model research or place trades. No schema migration is required.

## What visitors see

- Separate BTC momentum and news research status cards.
- A decision journal with All, BTC and News filters.
- Recorded warmup, research, skip, interruption, hypothetical signal, paper entry and settlement states.
- Expandable inputs: BTC index, completed one-minute returns, YES quotes, available size, estimated probability and edge, when present in the record.
- News summaries and citations only when evidence URLs match recorded search results.
- Relative decision timestamps and warnings when updates are overdue.
- The latest 20 records per agent, plus six recent BTC fills and settlements so frequent skips do not bury milestones.

Paper entries are identified from the persisted run decision and paper mode. A paper candidate blocked by a risk limit remains a skip. Hypothetical news signals remain log-only. Research sources are labeled as not independently audited.

## Public data boundary

These are concise decision summaries and observable workflow stages, not private model reasoning or token-by-token model output. The API maps an explicit set of public fields; it does not return raw signals, encrypted reasoning, raw exception messages or credentials. Operational reasons use known descriptions. Source links require public HTTPS URLs without embedded credentials and must match retrieved evidence.

## Implementation

| File | Purpose |
| --- | --- |
| `apps/web/app/agents/page.tsx` | Dynamic server-rendered page and initial data load |
| `apps/web/app/api/agents/activity/route.ts` | Uncached polling endpoint |
| `apps/web/lib/agent-activity-data.ts` | Bounded reads from the existing database |
| `apps/web/lib/agent-activity.ts` | Public response types, safe field mapping and decision summaries |
| `apps/web/components/agent-activity.tsx` | Polling, status cards, filters, inputs and citations |
| `apps/web/app/layout.tsx` | Header link |
| `apps/web/components/primary-tabs.tsx` | Active AI navigation on `/agents` |
| `apps/web/test/agent-activity.test.ts` | Regression coverage for the public response boundary and decision states |

## Verification

- All **192 repository tests passed**.
- Full repository typecheck passed.
- Production web build passed, including `/agents` and `/api/agents/activity`.
- The local endpoint returned actual local Postgres worker records: 27 records at the verification checkpoint, including BTC skips and retained milestones.
- Seven new tests cover private-field exclusion, blocked paper candidates, hypothetical versus executed decisions, official settlement summaries, warmup inputs, citation provenance, malformed records and news progress.

Visual browser verification remains incomplete. The in-app browser reached a different localhost service; native browser automation then stopped because it could not confidently determine the Windows browser URL. Responsive styling is implemented, but desktop and mobile layouts still need visual review. The feature has not been deployed to the hosted website.

## Running locally

Use the existing web development command with the server's `DATABASE_URL` set to the intended database. The web app does not automatically load the repository-root worker `.env`; configure the web process environment without committing credentials. Then visit `/agents`. With no connection, the page displays a connection error and retries. With no recorded runs, it displays an empty state.

News scheduling remains disabled in the local supervised worker. A historical news record does not imply that research is currently running. News paper execution, an independent factual audit and Circle escrow integration remain separate work.

The accompanying `docs/btc-paper-worker.md` update records the first live BTC paper entry and its official settlement as a historical checkpoint; it does not claim completion of the three-trade exit criterion.
