# Changelog

Tutte le versioni notevoli di PloppyTV sono documentate in questo file. Il formato si ispira a [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) e il progetto segue [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nessuna modifica.

## [1.2.1] — Stress-test bug-fix release (luglio 2026)

**Tag:** `v1.2.1`
**Data compatibility:** 100% con v1.2.0 (nessuna migrazione necessaria, schema invariato v2).

Release di sola affidabilità. **Nessuna nuova feature**: ogni cambiamento corregge un bug trovato da uno stress test automatico. Uno sciame di **20 sub-agent** ha esercitato ogni modulo e ogni edge case, portando alla luce ~170 bug (più di 100 fixati in questo rilascio). I probe test scritti durante lo stress test sono mantenuti come **suite di regressione di 1124 test** (da 870 a 1994 test totali).

### Sicurezza

- **XSS defense-in-depth**: `stripHtml` applicato a `ep.name`, `note`, `tags` in `normalize.ts` e `shows.ts` (i dati utente/importati ora sono sanitizzati a monte, non solo a render). `imgTag` valida `src` con `safeImageUrl` (rifiuta `javascript:`/`data:`). Escape di `cls`/`extraStyle` in tutti gli attributi del placeholder. `data-show-id` escapato in tutte le viste. Verifica end-to-end: nessun tag `<script>` o event handler sopravvive nel DOM dopo il render.

### Corretto (High)

- **`notifications.ts`**: `NOTIF_MAX_DELAY_MS` superava il limite di 2³¹−1 ms di `setTimeout` → overflow int32 → notifiche sparate immediatamente. Ridotto a 24 giorni (safe).
- **`store.ts`**: `setShows(null/non-array)` corrompeva lo state; reference array condivise con il caller; snapshot non deep-clonava `tags`/`genres`; `emitChange` con reentrancy (listener iscritto durante emit poteva fireare nello stesso flush).
- **`storage.ts`**: `loadData` crashava se `getItem` lanciava `SecurityError` (private mode Safari); CAS inattivo quando `_lastSavedAt=null` (race multi-tab); recovery da corruzione scriveva raw corrotto nel backup; `savedAt=NaN` rompeva CAS (`NaN !== NaN` sempre true → ogni save rifiutato).
- **`worker/client.ts`**: `postMessage` su dati non-cloneable (funzioni, ref circolari) lanciava `DataCloneError` → leak di listener/timeout + nessun fallback. Fallback main-thread che lanciava dentro callback → promise hang infinito (loader eterno).
- **`compute.ts`**: `computeStats`/`computeCalendar` crashavano su `shows` con entry `null`/non-object; `topGenres` faceva double-count di generi duplicati nello stesso show.
- **`imageFallback.ts`**: loop infinito con `fallbackSrc` relativo (confronto stringa falliva). Ora usa flag `data-fallback-src-tried`.
- **`keyboard.ts`**: `Ctrl`/`Cmd`/`Alt` non erano ignorati per gli shortcut lettera → `Ctrl+g` poi `Ctrl+d` navigava sovrascrivendo i bookmark del browser.
- **`yearReview.ts`**: `canvas.toBlob` non in try/catch → `SecurityError` su tainted canvas (CORS poster TVMaze) propagato come uncaught. `URL.revokeObjectURL` non chiamata se `a.click()` lanciava (leak blob URL).
- **`shows.ts`**: `refreshShowEpisodes` perdeva `rating` e `note` dell'utente ad ogni refresh API; wipava tutti gli episodi se l'API ritornava array vuoto (glitch temporaneo).
- **`modal.ts`**: `initModal` non idempotente → listener duplicati su re-init/HMR (ESC poppava 2 entry per keypress). Focus trap non includeva `textarea`/`select`/`summary` (Tab usciva dal dialog).

### Corretto (Medium/Low)

- **`utils.ts`**: `localISODate(Date(NaN))` restituiva `"NaN-NaN-NaN"`; `stripHtml` leaka testo in `title="a>b"`; `parseISODateLocal` accettava rollover (`2024-02-30` → `2024-03-01`); `safeNum` accettava hex/octal/scientific; `findNextEpisode` non validava `num`.
- **`normalize.ts`**: `buildShowFromTvmaze` usava regex loose per date (accettava `2024-13-40`); `Infinity` runtime passava il check `> 0`; `watched` truthy contava `"false"` come visto.
- **`api.ts`**: race tra timeout interno e external abort (propagava `AbortError` invece di `TimeoutError`); wrapper `?? []` lasciava passare risposte JSON non-array.
- **`discover.ts`**: `recentOnly` includeva show con `premiered` futuro; `cancelAnimationFrame` non chiamato a fine fetch (callback post-resolve); `weight` non-numerico avvelenava il sort.
- **`dashboard.ts`/`showList.ts`**: bottone "Sorprendimi" inerte dopo re-render; filtro tag intrappolava l'utente al cambio lista (chip-bar spariva, nessun modo per clearare); XSS su `ep.num` non coerced.
- **`showDetail.ts`**: `seasonAvgRating` NaN/Infinity; guard su `tags`/`genres`/`seasons` non-array mancanti.
- **`yearReview.ts`**: `watched` truthy; `airdate` non-stringa crashava; `runtime` stringa concatenava (`0+"30"="30"`, poi `"30"+30="3030"`); filename `ploppytv-NaN.png` se anno NaN.
- **`toast.ts`**: `showToast(null/undefined)` mostrava `"null"`/`"undefined"`; nessuna API per dismiss manuale.
- **`header.ts`**: `initHeader` non idempotente; sidebar mobile senza scroll-lock né ESC chiusura; `updateBadges` crashava su `shows` non-array.
- **`i18n.ts`**: `t()` crashava su chiavi con metacaratteri regex; lang salvata case-sensitive (`EN` rifiutato); param `null` → letterale `"null"`.
- **`storage.ts`** (post-stress): `loadData` + storage event ora deduplicano show per id (keep first); storage event avverte su version passata e rigetta version non-numerica (consistente con `loadData`).

### Test

- **+1124 test di regressione** (870 → 1994 totali, 0 falliti) in 20 nuovi file `tests/probe_a*.test.ts`, uno per componente. Coprono: date invalide, NaN/Infinity, type confusion, prototype pollution, XSS end-to-end, race condition worker/search, multi-tab CAS, storage quota/corruzione, import enormi, edge case keyboard/modal.

### Modifiche ai file

- 33 file sorgenti modificati in `src/` + `index.html`
- 20 nuovi file `tests/probe_a*.test.ts`
- `package.json`/`package-lock.json` bumped a 1.2.1

## [1.2.0] — P2 Quality of life quotidiana

### Aggiunto

**P2 — Quality of life quotidiana (9 item completati)**

Feature che migliorano l'uso quotidiano dell'app, con focus su polish del modello locale esistente (no nuova architettura). Schema bumped a v2 per supportare i nuovi campi.

- **Rating 5★ per episodio** (`src/lib/shows.ts`, `src/views/showDetail.ts`) — stelle 1-5 cliccabili per ogni episodio, toggle (clicca di nuovo la stessa stella per rimuovere), media stagione mostrata sopra la lista episodi. Campo `rating?: number` aggiunto a `Episode`.
- **Note private per episodio** (`src/views/showDetail.ts`) — editor modale con textarea (max 500 char) e contatore caratteri in tempo reale, anteprima nota sotto l'episodio, indicatore visivo (punto arancione) sulle note esistenti. Campo `note?: string` aggiunto a `Episode`.
- **Tag personalizzabili per serie** (`src/lib/shows.ts`, `src/views/showDetail.ts`, `src/views/showList.ts`) — aggiunta/rimozione tag dal dettaglio serie con modale + suggerimenti da tag esistenti, filtro tag nelle liste watching/towatch/completed, dedup case-insensitive, max 20 tag per serie. Campo `tags?: string[]` aggiunto a `Show`.
- **Search avanzata nella libreria** (`src/views/library.ts`) — nuova vista "Libreria" con filter bar completa: ricerca testuale + 6 filtri (genere, status, rating minimo, network, anno premiere, tag). Risultati reattivi in tempo reale, pulsante "Cancella filtri".
- **Rivedi un episodio casuale** (`src/lib/shows.ts`, `src/views/dashboard.ts`) — card in dashboard con gradient oro che suggerisce un episodio 5★ a caso. Usa `crypto.getRandomValues` per random sicuro, apre il dettaglio serie e mostra toast con info episodio.
- **Keyboard shortcuts** (`src/lib/keyboard.ts`) — `/` focus search, `g d/c/s/l/y` navigazione viste (dashboard/calendar/stats/library/yearreview), `j/k` naviga episodi, `w` toggle watched, `?` mostra cheat sheet modale. Sequenze `g+lettera` con timeout 800ms. Ignorato quando si scrive in input/textarea.
- **i18n IT + EN** (`src/lib/i18n.ts`, `src/locales/it.json`, `src/locales/en.json`) — framework i18n custom (zero dipendenze) con 150+ chiavi tradotte. Default da `navigator.language`, persistenza lingua in localStorage (`ploppytv_prefs_v1`), switcher lingua nella sidebar, re-render automatico al cambio lingua via subscribe pattern.
- **Statistiche Year-in-Review** (`src/views/yearReview.ts`) — nuova vista "Anno in TV" con selettore anno, 4 stat card (episodi totali, ore, genere dominante, stagione più longeva), top 5 serie viste, export PNG 1080×1350 via canvas (gradient background, branding PloppyTV). Stima visioni annuali basata su airdate episodio.
- **Notifiche push per nuovi episodi** (`src/lib/notifications.ts`) — Notification API (no backend richiesto), scheduling locale con `setTimeout` 1 ora prima dell'airdate delle serie in watching, re-scheduling ogni 6 ore, toggle nella sidebar, opt-in esplicito con `Notification.requestPermission()`. Persiste lo stato in localStorage.

### Modificato

- `SCHEMA_VERSION` bumped da 1 a 2 (`src/lib/constants.ts`) — nuovi campi `rating`, `note` su `Episode` e `tags` su `Show`. Migrazione automatica: `normalizeShow` gestisce i nuovi campi con validazione (rating 1-5, note trim+truncate 500 char, tags dedup case-insensitive + max 20).
- `src/lib/normalize.ts` — `normalizeShow` ora preserva e valida `rating`, `note`, `tags`. `buildShowFromTvmaze` inizializza `tags: []`.
- `src/lib/constants.ts` — aggiunte costanti: `MAX_EPISODE_NOTE_LENGTH`, `MAX_EPISODE_RATING`, `MAX_TAG_LENGTH`, `MAX_TAGS_PER_SHOW`, `PREFS_KEY`, `NOTIF_LEAD_TIME_MS`, `NOTIF_RESCHEDULE_INTERVAL_MS`.
- `src/main.ts` — init di `initI18n()`, `initKeyboard()`, `initNotifications()`, subscribe a `subscribeI18n` per re-render al cambio lingua, dispatch evento `ploppytv:reschedule-notifications` su state change.
- `src/components/renderer.ts` — aggiunti case `library` e `yearreview` per le nuove viste.
- `src/components/header.ts` — aggiunti handler per toggle notifiche (`#notifBtn`) e switcher lingua (`#langBtn`).
- `src/views/dashboard.ts` — aggiunta card "Rivedi un episodio oro" con event handler.
- `src/views/showDetail.ts` — aggiunte stelle rating, pulsante nota, sezione tag, media stagione, modali editor nota e aggiunta tag.
- `src/views/showList.ts` — aggiunta tag filter bar.
- `index.html` — aggiunti nav item per Libreria, Anno in TV, Notifiche, Lingua.
- `src/styles/main.css` — aggiunti ~450 righe di CSS per tutte le nuove feature P2.
- `docs/roadmap.html` — tutti i 9 item P2 marcati come ✓ Completata.
- `README.md` — aggiornata tabella roadmap (P2 ✅), aggiunta sezione P2 dettagliata, aggiunte feature P2 alla lista funzionalità.

### Test

- `tests/p2_features.test.ts` (nuovo) — 26 test per: schema v2 (rating/note/tags normalizzazione), i18n (init, setLocale, t(), interpolazione, fallback), getRandomGoldEpisode (guard null seasons, 5★ filter), getAllUserTags, keyboard module, notifications module.
- `tests/probe_exportimport.test.ts` — aggiornato assertion `version` da 1 a 2.
- Suite totale: 870 test passanti (26 nuovi + 844 esistenti), 0 falliti.

## [1.1.0] — 2026-07-09

### Aggiunto

**P1 — Fondamenta & igiene del progetto**

Tutti i 7 item della fase P1 della roadmap completati. L'obiettivo di P1 era colmare i gap bloccanti per poter condividere l'app con conoscenti in buona fede: niente più "All rights reserved" implicito, niente più regressioni silenziose su bug già fixati.

- **Licenza MIT** (`LICENSE`) — prima di questo commit il codice era tecnicamente "All rights reserved" nonostante la repo fosse pubblica. Ora è ufficialmente MIT, fork-able e reuse-able con attribuzione.
- **Privacy policy formale** (`PRIVACY.md`) — pagina Markdown con TL;DR, sezioni dettagliate su dati raccolti, chiamate a TVMaze, cookie, GDPR, contatti. Linkata dal modal "Informazioni" dentro l'app. Traduce in linguaggio umano ciò che era già vero nel codice: nessun tracking, nessun backend, dati solo in localStorage.
- **ESLint + Prettier + Husky** — config minimale con `eslint:recommended`, `@typescript-eslint/recommended`, `eslint-config-prettier`. Pre-commit hook via Husky 9 + lint-staged esegue `eslint --fix` e `prettier --write` sui file modificati. Blocca commit con errori o warning non giustificati.
- **Vitest + 64 test core** — suite di test con environment jsdom. Coverage 31% statements, 86% branches sui moduli critici di `src/lib/` (`normalize.ts`, `utils.ts`, `store.ts`, `watched.test.ts`). Soglia minima 30% enforced in CI. Previene regressioni sui 145 bug già fixati nello stress test precedente.
- **`CONTRIBUTING.md`** — guida completa per contributor: prerequisiti, setup, struttura del progetto, convenzioni TypeScript/ESLint/Prettier/commit, workflow di una PR, code of conduct. Include issue template (Bug Report, Feature Request) e PR template.
- **README arricchito** — aggiunti badge (License, TypeScript, Vite, PWA, CI, Deploy), screenshot placeholder, sezioni test/privacy/roadmap/contribuire. Rende il progetto immediatamente comprensibile a un visitatore GitHub casuale.
- **GitHub Release v1.1.0** — prima release "ufficiale" post-v1.0 con tag, changelog (questo file) e release notes. Milestone psicologica: il progetto esce dalla fase "bozza" ed entra "usabile e manutenibile".

### Modificato

- `package.json` versione bumped da 2.0.0 a 1.1.0 (allineamento con il tag GitHub Stable = v1.0.0, che resta la prima release ufficiale).
- Modal "Informazioni" (`src/components/header.ts`): aggiunti link a Privacy Policy, Contributing, Licenza MIT. Versione mostrata aggiornata a 1.1.0.
- CI (`.github/workflows/ci.yml`): aggiunto job `lint` (ESLint + Prettier check) e job `test` (Vitest). In precedenza la CI faceva solo typecheck + build.
- `tsconfig.json`: aggiunti `tests` agli include, `vitest/globals` ai types. Necessario per far compilare i file di test.

### Rimosso

- `console.log` da `src/main.ts` (warning ESLint `no-console`). Sostituito con `void reg;` per indicare esplicitamente che il callback `onRegistered` è intenzionalmente no-op in produzione.

### Tecnico

- **Dipendenze aggiunte** (devDependencies):
  - `eslint@^8.57.1`, `@eslint/js@^8.57.1`, `typescript-eslint@^7.18.0`, `eslint-config-prettier@^9.1.2`
  - `prettier@^3.9.4`
  - `husky@^9.1.7`, `lint-staged@^15.5.2`
  - `globals@^15.15.0`
  - `vitest@^1.6.0`, `@vitest/coverage-v8@^1.6.0`, `jsdom@^24.0.0`
- **Config file nuovi**: `.eslintrc.cjs`, `.prettierrc.json`, `.prettierignore`, `.lintstagedrc.cjs`, `vitest.config.ts`, `.husky/pre-commit`
- **Cartelle nuove**: `tests/` (4 file di test + helpers), `screenshots/` (placeholder + README), `docs/` (questo changelog e la roadmap)
- **Issue templates**: `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`, `config.yml`
- **PR template**: `.github/PULL_REQUEST_TEMPLATE.md`

## [1.0.0] — 2026-07-08

Prima release ufficiale. Riscrittura completa rispetto al prototipo originale in HTML singolo (114 KB), con architettura modulare TypeScript + Vite + PWA.

### Aggiunto

- **Vite 5** come bundler e dev server
- **TypeScript 5** in modalità strict
- **Vanilla JS** (nessun framework React/Vue) — logica applicativa preservata dall'originale
- **vite-plugin-pwa** — Service Worker basato su Workbox, con precache e runtime caching separato per API e immagini
- **Web Worker** dedicato al calcolo di statistiche e calendario, per non bloccare la UI su liste grandi
- **Code-splitting per vista** — Discover, Calendar, Stats e ShowDetail sono chunk lazy-loadati separati
- Dashboard, liste per stato (in visione / da vedere / completate), dettaglio serie, scopri, calendario settimanale, statistiche personali, ricerca TVMaze, backup/import JSON
- Workflow GitHub Actions per CI (typecheck + build) e deploy automatico su GitHub Pages

### Ottimizzazioni rispetto al prototipo originale

| Ottimizzazione | Effetto |
| --- | --- |
| Code-splitting per vista | Carico iniziale ridotto del 26% (gzip: 26.8KB → 19.8KB) |
| Web Worker per stats/calendario | La UI non si blocca su liste grandi |
| Service Worker via Workbox | Caching robusto con expiration plugin, cache separate per API e immagini |
| Event delegation globale | Un singolo handler di click al posto di centinaia di `onclick` inline |
| Fallback immagini delegato | Un solo handler `error` in capture-phase invece di un `onerror` per ogni immagine |
| TypeScript strict | Type safety senza overhead a runtime |
| `preconnect` verso TVMaze | -100/300ms di Time To Interactive alla prima visita |
| `loading="lazy"` diffuso | Minor consumo di banda al caricamento iniziale |

### Affidabilità: 145 bug fixati da stress test

L'ultimo giro di sviluppo pre-v1.0 si è concentrato sulla robustezza dell'app in scenari reali. Sintesi delle aree principali:

- **Storage multi-tab**: scritture concorrenti tra tab diverse ora usano un controllo ottimistico (CAS su `savedAt`); se un'altra tab ha già salvato, la scrittura corrente viene rifiutata.
- **Modali nidificate**: `modal.ts` gestisce uno stack di modali con focus trap, `role="dialog"`, `aria-modal`, gestione ESC.
- **Web Worker**: le richieste portano un `id` di correlazione; risposte in ritardo da richieste precedenti non vengono più confuse con quella corrente.
- **Aggiornamento PWA**: un nuovo Service Worker "in attesa" mostra un toast che permette di applicare subito l'update.
- **Routing con hash**: gli shortcut PWA e i deep link a una serie sono interpretati anche dopo il caricamento iniziale e supportano avanti/indietro del browser.
- **Ricerca TVMaze**: corretta una race condition per cui i risultati di una ricerca precedente potevano sovrascrivere quelli di una più recente.
- **Normalizzazione dati**: sanitizzazione più rigorosa (percentuali di progresso e conteggi episodi ora sempre in range valido, niente più `NaN`/negativi).

### Migrare dati dalla versione originale

La struttura dati `ploppytv_data_v1` in localStorage è identica e compatibile con quella della PWA originale: se la avevi già installata, i tuoi dati vengono riconosciuti automaticamente.
