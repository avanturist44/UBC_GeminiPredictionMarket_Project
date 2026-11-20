# Animated ASCII background

Website work is isolated on `codex/website-ascii-background`, based on the shared
website at `2ef8008`. The extension branch is unchanged.

The background is a slow monochrome field of `.`, `:` and `+` contours. It is
decorative, not market data. Definition is strongest at the margins and quieter
in the reading area; the sidebar keeps its existing opaque surface. Content,
navigation, APIs and trading behavior stay as they were.

Trade posts and reusable thesis cards have explicit, opaque `bg-background` surfaces
so the ASCII field does not show through their content. Position panels retain their
existing solid card color. This applies in `components/post.tsx` and
`components/thesis-card.tsx`. The production rebuild and TypeScript checks passed;
the local Home feed returned no thesis cards during the follow-up browser check,
so a live card could not be visually inspected in that preview.

Implementation:

- `apps/web/components/ascii-background.tsx`: client-only canvas drawing, capped at
  10 updates per second, with bounded resolution and row-based text rendering.
- `apps/web/app/layout.tsx`: mounts the background alongside the existing server layout.
- `apps/web/app/globals.css`: isolated background layer, subdued mobile opacity and
  an understated pause control clear of the mobile tab bar.
- `.gitignore`: excludes generated `.local` browser tooling/caches from source scans
  and commits; existing local files are preserved.
- `scripts/verify-ascii-background.mjs`: browser verification and screenshots.

Pause freezes the current pattern and saves the preference locally. Reduced-motion
preferences render a static field. Hidden tabs stop scheduling frames. Resize and
effect listeners are cleaned up on unmount. The canvas ignores pointer input and
is hidden from assistive technology. No dependencies were added.

To preview locally, from the repository root:

```powershell
node apps/web/node_modules/next/dist/bin/next dev apps/web --webpack --hostname 127.0.0.1 --port 3217
```

Visit `http://127.0.0.1:3217/how-it-works` or any existing route. Do not run a
production build concurrently with the dev preview. TypeScript validation:

```powershell
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
```

Browser verification focuses on the actual website's reading page, with client API
requests blocked to keep live services out of visual testing. It checks changing
canvas frames, pause/local preference, reduced motion, decorative semantics and
390px/1440px layouts. It does not verify live markets, authentication or trades.

Optional browser tooling and verification (with the local website running):

```powershell
npm install --prefix .local/browser-tools playwright-core
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.local/browser-cache"
node .local/browser-tools/node_modules/playwright-core/cli.js install chromium
node scripts/verify-ascii-background.mjs
```

Use `ASCII_PREVIEW_ORIGIN` to test a different local port. Captures and browser results
are saved alongside this document.

## Verification

- Production webpack build passed, including TypeScript and all route compilation:
  `node apps/web/node_modules/next/dist/bin/next build apps/web --webpack`.
- Standalone TypeScript checking and `git diff --check` passed.
- Browser checks passed against the built website, with no page errors. See
  [the report](report.json), [desktop capture](desktop.png) and [mobile capture](mobile.png).
- Client API calls were blocked for these UI checks. Backend and trading functionality
  were not exercised or changed. Early dev-preview runs encountered bundle loading
  timeouts; final verification used the production build.

The Sites skill's local repository workflow was used. No deployment or merge into
the shared branch was performed.

## Team branch freshness check

Remote references were fetched again after the solid-card request. `origin/main`
remains at `2ef8008`, and is already an ancestor of this website branch.

| Remote branch | Relationship to the website baseline |
| --- | --- |
| `main` | Latest shared head fully included |
| `model-arena-and-tip-retries` | Fully included through main |
| `phase-3` | Fully included through main |
| `ashley` | Older root-level extension prototype; integrated into main by `963f180`, not a direct ancestry merge |
| `avi/extension-ui-redesign` | Two separate UI commits from the older `963f180` base; main has a newer extension implementation |
| `avi/ubc-hack` | Diverged, with 17 unique commits including alternate backend/services, contracts and schema migrations |

The user chose to keep the latest shared main baseline. Older diverged branches
remain separate. All website UI commits and pushes stay on
`codex/website-ascii-background`; nothing is merged or pushed to `main`.
