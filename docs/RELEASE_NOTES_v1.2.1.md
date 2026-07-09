# PloppyTV v1.2.1 — Stress-test bug-fix release

**Tag:** `v1.2.1`
**Date:** luglio 2026
**Reference commit:** see [releases](https://github.com/Cartaz/PloppyTV/releases/tag/v1.2.1)
**Data compatibility:** 100% con v1.2.0 (nessuna migrazione necessaria, schema invariato v2)

## Summary

**v1.2.1** è una release di sola affidabilità. **Nessuna nuova feature** — ogni cambiamento corregge un bug trovato da uno stress test automatico. Uno sciame di **20 sub-agent** ha esercitato ogni modulo e ogni edge case della codebase, portando alla luce ~170 bug (più di 100 fixati in questo rilascio). I probe test scritti durante lo stress test sono mantenuti come **suite di regressione di 1124 test** (da 870 a 1994 test totali, 0 falliti).

Nessuna migrazione dati richiesta. Lo schema `ploppytv_data_v2` in localStorage è invariato e pienamente retrocompatibile.

## Sicurezza

### XSS defense-in-depth

Lo stress test ha verificato end-to-end (render in jsdom + ispezione DOM) che **nessun tag `<script>` o event handler sopravvive** dopo il render di qualsiasi vista, anche con input malevoli su `show.name`, `summary`, `note`, `tag`, `ep.name`, `data-*` attributi. Tuttavia, la difesa era solo a render-time: i dati utente/importati venivano salvati raw nello store. In v1.2.1 la sanitizzazione avviene anche a monte:

- **`normalize.ts`**: `stripHtml` applicato a `ep.name`, `note`, `tags` (i dati importati da backup malevoli o da API TVMaze compromesse ora sono sanitizzati prima di entrare nello store).
- **`shows.ts`**: `refreshShowEpisodes` ora fa `stripHtml` su `ep.name` (allineato a `normalize.ts`).
- **`img.ts`**: `imgTag` valida `src` con `safeImageUrl` → rifiuta `javascript:`, `data:`, URL non-http(s). Prima interpolava `src` raw dopo solo `escapeAttr` (che non blocca scheme pericolosi).
- **`img.ts`**: escape di `cls`/`extraStyle` in **tutti** gli attributi del placeholder `<div>` (prima il `style` attribute interpolava `extraStyle` raw → XSS se conteneva `"`).
- **`renderer.ts`**: `data-show-id` escapato via `safeId` in tutte le viste (attribute breakout prevention).
- **`renderer.ts`**: `safeImport` usa `data-action` invece di `onclick` inline (CSP-safe).

## Critical / High fixes

### H1 — Notifiche sparate immediatamente per overflow di `setTimeout`

**File:** `src/lib/notifications.ts` + `src/lib/constants.ts`

`NOTIF_MAX_DELAY_MS` era impostato a 30 giorni (~2.592.000.000 ms), che supera il limite di 2³¹−1 ms (2.147.483.647 ms) di `setTimeout`. L'overflow int32 faceva sì che le notifiche per episodi lontani venissero **sparate immediatamente** invece che 1 ora prima dell'airdate. Ridotto a 24 giorni (safe margin), con `Number.isFinite` guard su season/epNum per evitare body notification malformati.

### H2 — Store corrompibile + reference condivise + reentrancy

**File:** `src/lib/store.ts`

- `setShows(null)`, `setShows(undefined)`, `setShows(non-array)` corrompevano `state.shows` → crash downstream in `.map`/`.filter`.
- Le reference array di `shows` erano condivise con il caller: un `.push`/`.splice` esterno corrompeva lo store.
- `getStateSnapshot` faceva shallow clone (`{...s}`) → `tags` e `genres` restavano shared ref: `snap.shows[0].tags.push()` leakava nel live state.
- `emitChange` iterava il `Set` live dei listener: un listener iscritto durante un emit fireava nello stesso flush (reentrancy); un listener rimosso da un altro listener veniva saltato silenziosamente.
- `subscribe(non-function)` aggiungeva garbage al Set → `TypeError` a ogni emit.

Fix: defensive copy (`.slice()`), deep-clone di `tags`/`genres`/`seasons` nello snapshot, `Array.from(listeners)` nell'emit con check `listeners.has(l)`, validazione input.

### H3 — Storage: crash, CAS saltato, backup corrotto, `NaN` rompe CAS

**File:** `src/lib/storage.ts`

- `loadData` crashava se `localStorage.getItem` lanciava `SecurityError` (Safari private mode, o revoca mid-session). Ora wrappato in try/catch con fallback in-memory.
- Il CAS (compare-and-swap su `savedAt`) era **inattivo** quando `_lastSavedAt=null` (tab A carica storage vuoto, tab B scrive, tab A sovrascrive silenziosamente). La condizione `_lastSavedAt !== null && ...` era falsa con `_lastSavedAt=null`.
- La recovery da corruzione scriveva il raw corrotto (da `STORAGE_KEY`) nel `BACKUP_KEY` → distruggeva il backup valido. Ora `JSON.parse(prev)` prima di scrivere; se parse fallisce, skip backup.
- `savedAt` validato con `typeof === 'number'` (non `Number.isFinite`): `NaN` passava e rompeva CAS (`NaN !== NaN` sempre true → ogni save rifiutato).

### H4 — Worker: `postMessage` crash + fallback hang infinito

**File:** `src/worker/client.ts`

- `worker.postMessage(req)` lanciava `DataCloneError` su `shows` non-cloneable (funzioni, riferimenti circolari, `Symbol`) → leak di listener + timeout, nessun fallback, auto-reject senza cleanup. Ora wrappato in try/catch con cleanup completo.
- Il fallback main-thread (`computeStats(shows)` / `computeCalendar(...)`) poteva lanciare dentro event handler / `setTimeout` callback → la **promise hangava per sempre** (throw non catturato dal `Promise` constructor fuori dall'executor) → UI loader infinito. Ora `runFallbackOrReject` wrappa in try/catch e chiama `reject`.

### H5 — `computeStats` / `computeCalendar` crash su entry null

**File:** `src/worker/compute.ts`

`getState().shows` (usato da `stats.ts`) non filtra entry `null` (solo `getStateSnapshot()` filtra). `computeStats` faceva 5 accessi diretti (`s.totalEpisodes`, `s.list`, `s.runtime`, `s.genres`) → `TypeError` su entry null. `topGenres` faceva double-count di generi duplicati nello stesso show (`['Drama','Drama']`) e crashava su elementi non-stringa (`localeCompare` su numero). Fix: helper `safeShows` che filtra null/non-object, `Array.from(new Set(...))` per dedup generi.

### H6 — Image fallback loop infinito

**File:** `src/components/imageFallback.ts`

Con `fallbackSrc` relativo (es. `./icon.png`), il confronto stringa tra `img.src` (risolto assoluto) e `fallbackSrc` (relativo) falliva → l'handler reintegrava `fallbackSrc` → nuovo evento `error` → loop infinito. Ora usa flag `data-fallback-src-tried` invece di confronto stringa. Aggiunta anche `destroyImageFallback()` per cleanup.

### H7 — Keyboard: modificatori non ignorati

**File:** `src/lib/keyboard.ts`

`Ctrl`/`Cmd`/`Alt` non erano ignorati per gli shortcut lettera → `Ctrl+g` (focus address bar su alcuni browser) poi `Ctrl+d` (bookmark) veniva intercettato come sequenza `g`+`d` → navigava alla dashboard sovrascrivendo il comportamento del browser. Fix: `if (e.ctrlKey || e.metaKey || e.altKey) return;` + cancel pending `g`. Aggiunto anche: `?` inibito quando una modale è aperta.

### H8 — Year Review: `toBlob` uncaught + blob URL leak

**File:** `src/views/yearReview.ts`

- `canvas.toBlob` non era in try/catch → `SecurityError` su tainted canvas (CORS poster TVMaze, anche se attualmente il canvas disegna solo testo+gradiente, è defense-in-depth) propagato come uncaught error.
- `URL.revokeObjectURL` non chiamata se `a.click()` lanciava → leak di blob URL.
- `toBlob` availability non checkata (browser vecchi).
- Filename `ploppytv-NaN.png` se `year` era NaN.

Fix: try/catch completo + try/finally per revoke + availability check + validazione anno.

### H9 — `refreshShowEpisodes` perdeva rating e note

**File:** `src/lib/shows.ts`

Ad ogni refresh API, il nuovo `Episode` copiava solo `watched`/`airdate`/`name`/`runtime`, ignorando `rating` e `note` dell'`existingEp` → **l'utente perdeva tutte le valutazioni e le note personali** ogni volta che l'app aggiornava i dati serie. Fix: preserva `rating` (validato 1..MAX) e `note` (clamp 500). Altri fix nello stesso file: skip episodi `num=0`, dedup per `num` nella stessa stagione, non wipa i dati se API ritorna array vuoto (glitch temporaneo), guard su `show.seasons` null/array/non-object.

### H10 — Modal: init non idempotente + focus trap incompleto

**File:** `src/components/modal.ts`

- `initModal` non aveva guard di idempotency → chiamate ripetute (HMR, doppio init) aggiungevano listener ESC/Tab/click duplicati → ESC poppava 2 entry per keypress, focus trap girava 2 volte.
- `onClick` reentrancy: il check depth-based gestiva solo push. Se `onClick` chiamava `closeModal` (pop) o close+reopen (swap, depth invariato 1→1), il framework chiamava `closeModal` di nuovo → double-pop o chiusura della modale appena aperta.
- Focus trap selector mancava `textarea`, `select`, `summary` → la textarea dell'editor note e la select del language picker non erano incluse nel ciclo di wrap → Tab usciva dal dialog.
- Focus trap non preveniva Tab quando: nessun focusable nel dialog, o `activeElement` dentro dialog ma non focusable.
- Stack vuoto → overlay nascosto ma `modalBody`/`modalActions` `innerHTML` non puliti (contenuto stale nel DOM nascosto, info leak minore).
- `aria-labelledby='modalTitle'` sempre impostato, anche con titolo vuoto → screen reader annunciava titolo inesistente.

## Medium / Low fixes (selezione)

| Modulo | Bug |
|---|---|
| `utils.ts` | `localISODate(Date(NaN))` → `"NaN-NaN-NaN"`; `stripHtml` leaka testo in `title="a>b"`; `parseISODateLocal` accettava rollover (`2024-02-30`); `safeNum` accettava hex/octal/scientific; `findNextEpisode` non validava `num`. |
| `normalize.ts` | `buildShowFromTvmaze` regex loose accettava `2024-13-40`; `Infinity` runtime passava `> 0`; `watched` truthy contava `"false"` come visto. |
| `api.ts` | Race timeout/external-abort propagava `AbortError`; wrapper `?? []` lasciava passare JSON non-array. |
| `discover.ts` | `recentOnly` includeva show con `premiered` futuro; `cancelAnimationFrame` leak; `weight` non-numerico avvelenava sort. |
| `dashboard.ts` / `showList.ts` | Bottone "Sorprendimi" inerte dopo re-render; filtro tag intrappolava utente al cambio lista; XSS su `ep.num`. |
| `showDetail.ts` | `seasonAvgRating` NaN/Infinity; guard su `tags`/`genres`/`seasons` non-array. |
| `yearReview.ts` | `watched` truthy; `airdate` non-stringa crashava; `runtime` stringa concatenava (`0+"30"="30"`, poi `"30"+30="3030"`). |
| `toast.ts` | `showToast(null/undefined)` → `"null"`/`"undefined"`; nessuna API `dismissToast()`. |
| `header.ts` | `initHeader` non idempotente; sidebar mobile senza scroll-lock né ESC; `updateBadges` crash su `shows` non-array. |
| `i18n.ts` | `t()` crashava su chiavi con metacaratteri regex; lang case-sensitive (`EN` rifiutato); param `null` → `"null"`. |
| `storage.ts` (post-stress) | `loadData` + storage event ora **deduplicano show per id** (keep first); storage event **avverte su version passata** e **rigetta version non-numerica** (consistente con `loadData`). |
| `notifications.ts` | Listener leak cross-module-reload; `Number.isFinite` guard su season/epNum. |

## Test

**+1124 test di regressione** (870 → 1994 totali, 0 falliti) in 20 nuovi file `tests/probe_a*.test.ts`, uno per componente. Lo stress test ha usato un approccio misto:

- **Analisi statica** del codice + test d'attacco vitest con input avversari.
- **jsdom rendering** end-to-end (XSS verification: ispezione DOM post-render).
- **Mock di worker**, `fetch`, `localStorage`, `Notification`, `AbortController`, `crypto`, `canvas.toBlob`.
- **Fake timers** per race condition e timeout.
- **Cross-file edge cases**: storage quota piena, dati corrotti, import enormi, multi-tab CAS, date invalide, prototype pollution, type confusion, episodi duplicati, season 0.

Copertura per componente: `utils` (70), `normalize` (87), `store` (47), `storage` (16), `api` (33), `shows` (80), `discover` (22), `i18n`+`notifications`+`keyboard`+`constants` (69), `worker` (35), `dashboard`+`showList` (39), `showDetail` (XSS + P2), `discover`+`library` views, `calendar`+`stats`, `yearReview` (81), `modal`+`toast` (49), `search`+`exportImport`, `img`+`imageFallback`+`renderer`+`header`, `main`+`sw`+`index.html`, edge cases cross-cutting (A19+A20: 70+).

## Modifiche ai file

- 33 file sorgenti modificati in `src/` + `index.html`
- 20 nuovi file `tests/probe_a*.test.ts` (~1124 test)
- `package.json` / `package-lock.json` bumped a `1.2.1`
- `CHANGELOG.md` aggiornato con sezione `[1.2.1]`

## Verifica

```
typecheck:  tsc --noEmit           → OK (0 errori)
lint:       eslint --max-warnings=0 → OK (0 warning)
test:       vitest run              → 1994 passed, 56 skipped, 0 failed
build:      vite build + SW         → OK (dist/ generato, 30 precache entries)
```

## Aggiornamento

Nessuna azione richiesta. La PWA si aggiorna automaticamente al prossimo caricamento (il Service Worker mostra un toast "Aggiornamento disponibile"). I dati esistenti in `ploppytv_data_v2` sono pienamente compatibili.

---

© 2026 Cartaz — [MIT License](../LICENSE) — I metadati delle serie TV sono forniti dall'API pubblica gratuita di [TVMaze](https://www.tvmaze.com).
