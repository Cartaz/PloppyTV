# PloppyTV v1.1.1 — Stress-test bug-fix release

**Tag:** `v1.1.1`
**Date:** July 2026
**Reference commit:** see [releases](https://github.com/Cartaz/PloppyTV/releases/tag/v1.1.1)
**Data compatibility:** 100% with v1.1.0 (no migration needed)

## Summary

**v1.1.1** is a reliability & quality release. **No new features** — every change fixes a bug found by an automated stress test. A parallel swarm of **20 sub-agents** exercised every module and edge case, surfacing **143 bugs** (3 Critical, 20 High, 51 Medium, 69 Low). **14 parallel fix-agents** then patched them all with exclusive file ownership (no merge conflicts). The probe tests written during the stress test are kept as a **780-test regression suite**.

No data migration is required. The `ploppytv_data_v1` localStorage schema is unchanged and fully backward-compatible.

## Critical fixes (3)

### C1 — `reconcileAllLists` ignored `manualList`

**File:** `src/lib/normalize.ts:152-159` (called from `storage.ts` on load + multi-tab sync, and `exportImport.ts` on import).

A show the user manually placed in **"Da vedere"** or **"Completata"** (with `manualList=true`) was silently reverted on **every app load**, **every backup import**, and **every multi-tab storage event** — whenever the show had any watched episodes. The `manualList` flag was introduced precisely to prevent this, but only `updateShowListStatus` respected it; `reconcileAllLists` did not. Additionally, auto-promotion to `completed` did not clear `manualList` (unlike the other two reconcilers), trapping the show in `completed` even after the user un-marked episodes.

**Fix:** `reconcileAllLists` now mirrors `updateShowListStatus` — it honors `manualList` (no demotion when true) and clears it on auto-promotion to `completed`. The dead-code `reconcileList` function in `store.ts` (which had the same bug) was deleted entirely, leaving a single reconciler semantics across the codebase.

### C2 — External-abort propagation broken in `apiGet`

**File:** `src/lib/api.ts:42-48`

`apiGet` attached an `onExternalAbort` listener to the caller's `AbortSignal`, then scheduled `cleanup` (which removes that listener) via `Promise.resolve(...).then(cleanup)`. Since `Promise.resolve` is already resolved, `.then(cleanup)` ran on the **next microtask** — before `fetch` settled. After that microtask, the listener was gone: a subsequent `signal.abort()` from the caller never reached `controller.abort()`, so the in-flight fetch was **never aborted**. The README's "search race-condition fix" relied on this propagation; the UI stayed consistent only because of a secondary `searchSeq` guard, but every keystroke left a phantom fetch running for up to 10 s, risking HTTP 429.

**Fix:** Removed the microtask-cleanup hack; the listener is now removed in a `finally` block after `fetch` settles. External aborts correctly propagate to the in-flight fetch.

### C3 — `beforeunload` registered before `init()` could wipe user data

**File:** `src/main.ts:147-149` (registration) vs `init()` at L151

The `beforeunload` listener was registered at module level — **before** `init()` had loaded any data. If `init()` threw (any unguarded `initX` failure), the state remained `shows: []` with `_lastSavedAt: null`. On tab close, `saveData({immediate:true})` fired: the CAS check was skipped (both values null), so it wrote `shows: []` over the user's localStorage — **permanent data loss**.

**Fix:** `beforeunload` registration moved inside `init()`, after `loadData()` succeeds. `init()` is now wrapped in `try/catch` that logs the error and injects a fallback "Errore di avvio — Ricarica" UI so the app isn't bricked.

## High-severity fixes (20)

| ID | Area | File | Fix |
|----|------|------|-----|
| H1 | renderer | `renderer.ts`, `showDetail/discover/calendar.ts` | **Event-listener accumulation** — `resetBoundGuard` only reset a boolean flag, not the listener. After N re-renders, a click fired the action N times (double-toggles, N× saves, accelerating calendar-week drift 1→3→6→10). Now `removeEventListener`s the previous handler + keydown handler before binding. |
| H2 | storage | `store.ts`, `storage.ts` | **`_localDirty` never consulted** — the storage event overwrote unsaved debounced edits (300 ms window). Now consulted alongside `isModalOpen()`, and set/cleared by all `shows.ts` mutators. |
| H3 | storage | `storage.ts:90-102` | **`_lastSavedAt` advanced before write** — a failed write left it stale-high, permanently breaking CAS in-tab. Now advanced only after a successful `setItem`. |
| H4 | storage | `storage.ts:217-242` | **`storage` event `newValue=null` wiped data** — another tab clearing storage silently emptied this tab's shows. Now preserves local data + toasts if `shows.length > 0`. |
| H5 | storage | `storage.ts:230-238` | **Modal-open branch advanced `_lastSavedAt` to match** → next CAS passed and overwrote the other tab's newer data. Now leaves `_lastSavedAt` at the pre-event value so CAS fails and forces reload. |
| H6 | api | `api.ts:59-62` | **Empty body → `null as T`** — `getShowEpisodes` callers iterated `null` → TypeError. The three wrappers now coerce `null → []`. |
| H7 | normalize | `normalize.ts:38,70,115,128` | **Lax date regex** accepted `2024-13-40`, `2024-02-30`. Replaced with `parseISODateLocal(v) !== null` (strict). |
| H8 | normalize | `normalize.ts:101-124` | **`buildShowFromTvmaze` didn't reject `id:0`** (unlike `normalizeShow`). Now throws on invalid id. |
| H9 | normalize | `normalize.ts:142` | **Runtime had no upper bound** in `buildShowFromTvmaze` (accepted 5000+). Now clamped to [1,1000] with fallback 45, matching `normalizeShow`. |
| H10 | normalize | `normalize.ts:105-120` | **`buildShowFromTvmaze` didn't filter `ep.num>0`** — `num:0` episodes entered and broke `findNextEpisode`. Now filtered. |
| H11 | store | `store.ts:158-169` | **`reconcileList` had the same `manualList` bug as C1** and was dead code. Deleted. |
| H12 | exportImport | `exportImport.ts:131-137` | **Merge `Object.assign` wholesale-overwrote** `addedAt`/`manualList`/`image`. Now field-level merge preserving local metadata + calls `updateShowListStatus`. |
| H13 | main | `main.ts:50-144` | **`init()` unguarded** — any `initX` throw bricked the app. Now try/catch + fallback UI. |
| H14 | main | `main.ts:147-149` | **`beforeunload` ignored `saveData` return** — CAS failure silently lost edits. Now wrapped in try/catch (covered by C3). |
| H15 | discover-view | `discover.ts:130-176` | **Stuck "Caricamento…"** when re-render raced a slow fetch. Added `_loadTabToken` invalidation + removed redundant manual DOM ops. |
| H16 | calendar | `calendar.ts`, `client.ts` | **`computeCalendarFallback` lacked `safeOffset`** (NaN/Infinity crash) + `changeCalendarWeek` no NaN guard. Both fixed; fallback now shares logic with worker via `compute.ts`. |
| H17 | a11y | `index.html`, all views | **All clickable `<div data-action>` were keyboard-inaccessible** (WCAG 2.1 SC 2.1.1). Now carry `role`/`tabindex` + Enter/Space handlers. |
| H18 | normalize | `normalize.ts` | **`reconcileAllLists` didn't clear `manualList` on auto-promotion** (variant of C1). Now aligned. |
| H19 | showDetail | `showDetail.ts:245-270` | Listener accumulation (variant of H1). Fixed. |
| H20 | worker | `client.ts:24-26` | **`worker.onerror` didn't disable the worker** — a script-load error left it cached, causing a 500 ms timeout + fallback on every request forever. Now sets `_workerSupported=false`. |

## Medium & Low fixes (~120)

Selected highlights:

- **Progress bars clamped to [0,100]** across dashboard, showDetail, stats (was overflowing `width:166%` on corrupt data).
- **`safeImageUrl` applied in `getPosterUrl`** — `javascript:`/`data:` URLs can no longer reach `<img src>`.
- **`stripHtml` applied to `name`/`status`/`network`** in normalize (was only on `summary`).
- **Episode dedup** by `num` per season in both normalize paths.
- **UTF-16 BOM handling** for JSON imports (was only UTF-8).
- **Complete modal focus trap** — Tab/Shift+Tab now covers `modalBody` links, not just `modalActions`.
- **Correct maskable icon** — removed the 192 maskable entry that used a non-maskable image.
- **`<noscript>` fallback** added to `index.html`.
- **Worker/fallback code deduped** into a shared `src/worker/compute.ts` (eliminates ~110 lines of copy-paste drift risk).
- **ARIA**: toasts are `aria-live="assertive"`, search results are a WAI-ARIA `listbox` + `combobox`, nav badges have dynamic `aria-label`.
- **`showNeedsEpisodeNames`** now treats `name === ""` as missing (was only null/undefined).
- **`moveShowToList`** no longer sets `manualList=true` for "towatch" (was blocking natural promotion).
- **`refreshShowEpisodes`** matches by stable `id` first (preserves watched across TVMaze renumbering).
- **`emitChange`** guards `requestAnimationFrame` (falls back to `setTimeout` in non-RAF envs).
- **`getStateSnapshot`** deep-clones episode arrays (was sharing refs).
- **`safeNum`** rejects booleans/arrays (was `Number(true)===1`).
- **`parseISODateLocal`** rejects negative-year strings (V8 misparse).
- **`stripHtml`** handles unclosed `<script>`/`<style>`, CDATA, and single-pass entity decoding (no double-decode).
- **Quota size** uses UTF-8 byte length, not char count.
- **Corrupted-key cleanup** on successful `loadData`.
- **`onNeedRefresh`** dedup (no stacked reload buttons).
- ...and ~60 more (see `tests/probe_*.test.ts` for the full regression coverage).

## Metrics

- **Tests**: 842 passing (62 baseline + 780 probe regression suite), 0 failing, 56 skipped
- **Typecheck**: clean (`tsc --noEmit`)
- **Lint**: 0 errors, 0 warnings (`eslint --max-warnings=0`)
- **Format**: all files Prettier-compliant (`prettier --check`)
- **Build**: 28 precache entries (165.36 KiB), `sw.js` generated, `dist/` ~26 KB main chunk gzip
- **Diff**: 27 source files changed (+1194 / −589 lines), 1 new module (`src/worker/compute.ts`), 18 new probe test files (`tests/probe_*.test.ts`)

## Upgrade

### From v1.1.0

No action required. The `ploppytv_data_v1` localStorage schema is unchanged. The app updates automatically via the Service Worker; a toast offers to apply the update immediately.

### From v1.0.0 / original

Export a JSON backup from the old version, then import it into v1.1.1. The data structure is compatible. The import flow now handles UTF-16 BOMs and does field-level merging (preserves your local `addedAt` timestamps).

## Methodology

The stress test was structured as:

1. **20 sub-agents** (general-purpose), each owning one code area (`utils.ts`, `normalize.ts`, `store.ts`, `storage.ts`, `api.ts`, `shows.ts`, `discover.ts`, worker, modal, search, exportImport, renderer, dashboard, showDetail, discover-view, calendar, stats, main, sw/pwa, cross-cutting security/a11y).
2. Each agent read its assigned source files, wrote a **probe test file** (`tests/probe_*.test.ts`) that imported the real modules and verified bugs concretely (jsdom + mocked APIs), and produced a detailed bug report (`bug-reports/agent-NN-*.md`) with file:line, repro, expected/actual, and suggested fix.
3. **14 fix-agents** then ran in parallel, each with exclusive file ownership (no conflicts), applying the fixes and flipping the probe tests from "asserts bug" to "asserts fix" (regression tests).

All probe tests are kept and pass on every CI run, guarding against regressions.

## Acknowledgements

PloppyTV is "vibe coded" with the support of the GLM 5.2 model by Z.ai. The stress test and fixes for v1.1.1 were generated in collaboration with an AI assistant that coordinated 20 + 14 = 34 parallel sub-agents. The code is public and audit-able on [GitHub](https://github.com/Cartaz/PloppyTV).
