# Changelog

Tutte le versioni notevoli di PloppyTV sono documentate in questo file. Il formato si ispira a [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) e il progetto segue [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] — 2026-07-09

### Stress-test bug-fix release

Release di affidabilità e qualità. Nessuna nuova feature: ogni cambiamento fixa un bug trovato da uno stress test automatizzato. Uno swarm di 20 sub-agent paralleli ha esercitato ogni modulo ed edge case, individuando **143 bug** (3 Critici, 20 Alti, 51 Medi, 69 Bassi). 14 fix-agent paralleli li hanno poi patchati con ownership file esclusiva. I probe test dello stress test sono mantenuti come **regression suite da 780 test**. Dettagli completi in [`docs/RELEASE_NOTES_v1.1.1.md`](./docs/RELEASE_NOTES_v1.1.1.md).

### Critici (3)

- **`reconcileAllLists` ora rispetta `manualList`** — una serie collocata manualmente in "Da vedere"/"Completata" veniva silenziosamente ribaltata a ogni caricamento, import e sync multi-tab. Ora il reconciler onora l'override manuale e azzera `manualList` su auto-promozione a `completed`. La funzione dead-code `reconcileList` (stesso bug) è stata eliminata.
- **Propagazione dell'abort in `apiGet` riparata** — il listener `onExternalAbort` veniva rimosso al microtask successivo (prima che la fetch terminasse), quindi le richieste in-flight non venivano mai abortite. La "search race-condition fix" ora tiene davvero. Fix: cleanup nel `finally`.
- **`beforeunload` non sovrascrive più i dati se `init()` fallisce** — il listener era registrato prima di `init()`; se init lanciava, salvava `shows: []` sui dati dell'utente alla chiusura tab. Ora registrato dopo `loadData()` + init wrap in try/catch con UI di fallback.

### Alti (20, selezione)

- **Accumulo di event-listener** in `showDetail`/`discover`/`calendar` — `resetBoundGuard` ora `removeEventListener` prima di bindare. Le azioni non fire più N volte dopo N re-render (double-toggles, N× saveData, drift accelerante del calendario).
- **4 bug di perdita/corruzione dati multi-tab in `storage.ts`** — `_localDirty` consultato, `_lastSavedAt` avanzato post-write, no wipe su `newValue=null`, no advance a modal aperto.
- **`getShowEpisodes` non crasha su body vuoto** — i wrapper API coerciscono `null → []`.
- **`normalize.ts` indurito** — validazione date stretta, `buildShowFromTvmaze` allineato a `normalizeShow` (id/runtime/num), `stripHtml` su name/status/network.
- **Merge import field-level** — `Object.assign` (che perdeva `addedAt`/metadata locale) sostituito con merge che preserva i timestamp locali e riconcilia lo stato list.
- **`init()` guardato** con UI di fallback "Errore di avvio".
- **Accessibilità tastiera** — tutti i `div[data-action]` ora hanno `role`/`tabindex` + Enter/Space. Toast `aria-live`, search `listbox`, badge `aria-label`.
- **`worker.onerror` disabilita il worker rotto** (no loop 500ms).

### Medi / Bassi (~120)

Clamp progress ovunque, `safeImageUrl` in `getPosterUrl`, dedupe episodi, BOM UTF-16, focus trap modale completo, icona maskable corretta, `<noscript>`, dedupe worker/fallback in `src/worker/compute.ts`, e ~110 altri.

### Aggiunto

- `docs/RELEASE_NOTES_v1.1.1.md` — release notes complete in inglese
- `src/worker/compute.ts` — modulo condiviso per `computeStats`/`computeCalendar` (dedupe worker/fallback)
- `tests/probe_*.test.ts` (18 file, ~780 test) — regression suite per i bug fix

### Modificato

- 27 file sorgente (+1194 / −589 righe)
- Versione bumped da 1.1.0 a 1.1.1

### Metriche

- **Test**: 842 passing (62 baseline + 780 probe), 0 failing
- **Typecheck**: clean · **Lint**: 0/0 · **Format**: clean · **Build**: 28 precache entries (165 KiB)

### Compatibilità dati

Nessuna migrazione necessaria. Lo schema `ploppytv_data_v1` in localStorage è invariato e retrocompatibile.

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
