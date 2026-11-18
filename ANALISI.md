# Analisi di PloppyTV — 18 novembre 2026

Analisi in sola lettura del commit `1dc67e6` (branch `main`). L'unico file modificato è questo.
Legenda: **[V]** = verificato eseguendo il codice o con uno script di prova · **[L]** = verificato leggendo il codice · **[S]** = sospetto ragionato, non riprodotto.

## Riassunto

1. È una PWA vanilla TypeScript + Vite (tracker di serie TV, local-first, dati da TVMaze), piccola (~8.700 righe in `src/`) e funzionante: typecheck, lint, format, build, dev server e preview vanno.
2. Il problema non è l'architettura ma l'accumulo: 450 marcatori `BUG-xx` nei commenti, difese contro stati impossibili, codice morto e una suite di 31.000 righe di test "probe" divisa per agente invece che per modulo (3,5 righe di test per riga di codice).
3. Ci sono alcuni bug funzionali reali: note e tag alterati al ricaricamento, calendario e notifiche ciechi se non sei in pari con una serie, "Ultimi arrivi" di Discover basato su pagine fisse ormai superate, i18n EN fatta solo per metà.
4. La CI oggi fallirebbe allo step `npm audit` (17 vulnerabilità high, tutte nelle dipendenze di sviluppo) e i test falliscono su Node ≥ 25 (156 su 1.596) senza che il progetto dichiari la versione di Node richiesta.
5. **Conviene sistemarlo, non riscriverlo**: correggere i bug, togliere codice e commenti morti, consolidare i test. L'unica riscrittura parziale sensata è quella della suite di test (fase 5).

---

## 1. Cos'è e come si avvia

| Voce | Dettaglio |
| --- | --- |
| Scopo | Tracker personale di serie TV: liste, episodi visti, rating/note/tag, calendario, statistiche, Year-in-Review, Discover, backup JSON, notifiche locali |
| Stack | TypeScript 5.9 strict, Vite 6, vite-plugin-pwa (injectManifest + Workbox), Web Worker, Vitest 4 + jsdom, ESLint 8 + Prettier + Husky. **Nessuna dipendenza runtime** |
| Struttura | `src/lib` (store, storage, normalize, api, i18n…), `src/components`, `src/views` (caricate a richiesta), `src/worker`, `src/sw.ts`; `tests/` (49 file); CI + deploy su GitHub Pages |
| Avvio | `npm ci` → `npm run dev` / `npm run build` / `npm test` |

### Cosa ho eseguito (ambiente: Node 26.13.1, npm 12.2.3)

| Comando | Esito |
| --- | --- |
| `HUSKY=0 npm ci` | OK (604 pacchetti). npm 12 blocca il postinstall di `esbuild`, ma la build funziona lo stesso |
| `npm run typecheck` | OK, 0 errori |
| `npm run lint` | OK, 0 warning |
| `npm run format:check` | OK |
| `npm run build` | OK in ~0,8 s; bundle principale 72,5 kB (23 kB gzip); SW con 30 voci in precache |
| `vite` (dev) / `vite preview` | OK: `index.html`, `src/main.ts` e `sw.js` rispondono 200 |
| `npm test` | **KO: 156 test falliti su 1.596** (10 file). Causa: Node ≥ 25 espone un `localStorage` globale proprio che vale `undefined` e nasconde quello di jsdom (`TypeError: Cannot read properties of undefined (reading 'clear')`) |
| `NODE_OPTIONS=--no-webstorage npm test` | OK, 1.596/1.596 |
| `npm run test:coverage` (con il flag sopra) | OK: statements 94,2 %, branches 89,1 %, functions 95,5 %, lines 96,6 % (soglie rispettate) |
| `npm audit` | **28 vulnerabilità (17 high, 10 moderate, 1 low), tutte in devDependencies**; `npm audit --omit=dev` → 0. `npm audit --audit-level=high` esce con 1, lo stesso comando della CI |
| Scansione segreti su tutta la cronologia (167 commit, tutti i branch, più il contenuto di `Archivio.zip` cancellato) | Nessun segreto trovato |

La CI usa Node 22 e l'ultima esecuzione (30/09/2026) era verde. L'audit precedente (`docs/AUDIT_2026_09_30.md`) girava su Node 24, per questo non vedeva il problema di Node ≥ 25.

---

## 2. Problemi trovati

Ordinati per gravità. I problemi solo cosmetici li ho esclusi di proposito.

### Gravità alta

| # | Problema | Dove | Stato | Correzione proposta |
| --- | --- | --- | --- | --- |
| A1 | **Note e tag dell'utente vengono alterati al ricaricamento.** `setEpisodeNote`/`addShowTag` salvano il testo così com'è, ma al caricamento `normalizeShow` ci applica `stripHtml`. Prova: la nota `"2 < 3 > 1 &amp; co"` diventa `"2  1 & co"`, `"R&amp;B"` diventa `"R&B"`. È una perdita di dati silenziosa, e il CHANGELOG dice il contrario ("stripHtml applicato … in shows.ts") | `src/lib/shows.ts:385`, `src/lib/shows.ts:409`, `src/lib/normalize.ts:134-139`, `src/lib/normalize.ts:184-201` | [V] | Le note e i tag sono testo, non HTML: non applicarci `stripHtml` (il renderer fa già `escapeHtml`). Bastano trim e troncamento, sia in scrittura sia in lettura |
| A2 | **La CI fallirà al prossimo push e bloccherà il deploy.** `npm audit --audit-level=high` trova 17 high (catene picomatch/minimatch da `typescript-eslint@7`, `vite-plugin-pwa`/`workbox-build`, `lint-staged@15`, `vite`, `vitest`). Il deploy parte solo se la CI è verde | `.github/workflows/ci.yml:38-39`, `package.json` | [V] | Aggiornare `vite` e `vitest` (fix semver-compatibili), poi `typescript-eslint` 8, `lint-staged` 17, `vite-plugin-pwa` 2.x. In alternativa, nel frattempo: `npm audit --omit=dev` in CI, visto che il bundle non contiene nessuna di queste dipendenze |
| A3 | **I test falliscono su Node ≥ 25** (156) e non c'è nessun vincolo di versione: niente `engines`, niente `.nvmrc`. CONTRIBUTING dice "v22.x", ma solo a parole | `package.json`, `vitest.config.ts` | [V] | Aggiungere `"engines": {"node": ">=22"}` e `.nvmrc`. In `vitest.config.ts` impostare `execArgv`/`NODE_OPTIONS` con `--no-webstorage`, oppure usare `window.localStorage` nei test |

### Gravità media

| # | Problema | Dove | Stato | Correzione proposta |
| --- | --- | --- | --- | --- |
| M1 | **Calendario e notifiche considerano solo il *primo episodio non visto* di ogni serie.** Se sei indietro (S1E2 del 2020 non visto) e S2E1 esce oggi, il calendario della settimana è vuoto. Script di prova: `week.length = 0`, atteso 1. Per lo stesso motivo le settimane future mostrano al massimo un episodio per serie, e le notifiche non partono mai per chi non è in pari | `src/worker/compute.ts:172-192`, `src/lib/notifications.ts:167-190` | [V] | Calendario: elencare tutti gli episodi con `airdate` nella settimana (delle serie "watching"). Notifiche: prossimo episodio *in uscita*, non il prossimo *non visto* |
| M2 | **"Ultimi arrivi" di Discover si basa su pagine TVMaze fisse (340…370), ormai vecchie.** Interrogando l'API oggi: pagina 340 → 3 serie uscite negli ultimi 6 mesi, pagina 355 → 5, ma pagina 372 → 89 e pagina 380 → 124. Il commento "page 372 era out-of-range" non è più vero. Il tab si svuota col tempo | `src/lib/constants.ts:48-55`, `src/lib/discover.ts:37-49` | [V] | Ricavare le pagine in modo dinamico (cercare l'ultima pagina valida e prendere le ultime N), oppure usare `/schedule`/`/schedule/web` |
| M3 | **i18n EN fatta solo per metà.** 188 chiavi tradotte, ma **~130 non sono mai usate**: dashboard, dettaglio serie, calendario, statistiche, Discover, ricerca, toast di storage/serie/import e la navigazione in `index.html` restano in italiano anche dopo aver scelto "English". Le chiavi esistono già (`toast.serieAdded`, `dashboard.title`, …) | `src/lib/shows.ts` (29 stringhe), `src/lib/storage.ts` (16), `src/components/exportImport.ts` (25), `src/views/dashboard.ts:128`, `src/views/stats.ts:46`, `src/worker/compute.ts:82,105`, `index.html:113-198`, `src/main.ts:99,150,247` | [V] | Sostituire le stringhe con `t()` usando le chiavi già presenti, poi togliere quelle che restano inutilizzate. Altrimenti dichiarare l'EN "parziale" nel README |
| M4 | **"Unisci (smart)" nell'import perde dati.** Per una serie già presente: se il backup ha più episodi visti, *sostituisce* `seasons`, e quindi perde rating e note locali; altrimenti ignora tutto il backup (rating, note, tag). I tag del backup non vengono mai uniti | `src/components/exportImport.ts:179-206` | [L] | Unire episodio per episodio, per ID: watched = OR, rating/note = quello locale se c'è, altrimenti quello del backup; tag = unione |
| M5 | **Year-in-Review conta gli episodi in base alla data di uscita, non di visione.** Se nel 2026 recuperi una serie del 2010, finisce nel "2010". Il limite è scritto solo in un commento, non nell'interfaccia né nel README | `src/views/yearReview.ts:11-15`, `src/views/yearReview.ts:72` | [L] | Aggiungere `watchedAt` all'episodio quando lo segni come visto (schema v3, con migrazione), oppure dichiarare l'approssimazione nella vista |
| M6 | **Il salvataggio in `beforeunload` è superfluo e crea conflitti tra tab.** Ogni mutazione salva già subito. Il salvataggio alla chiusura riscrive lo stesso documento con un nuovo `savedAt`, quindi fa scattare un evento `storage` negli altri tab: un tab con una modale aperta (per esempio mentre scrivi una nota) ignora l'evento, resta con una revisione vecchia e tutti i suoi salvataggi successivi falliscono finché non ricarichi | `src/main.ts:290-296`, `src/lib/storage.ts:76-79`, `src/lib/storage.ts:338-343` | [L] (non riprodotto con due tab reali) | Togliere il listener `beforeunload`, oppure salvare solo se c'è davvero qualcosa di non salvato |
| M7 | **Guardia multi-tab morta.** `_localDirty` non viene mai messo a `true` in tutto `src/`, quindi il ramo che "protegge le modifiche locali" non si attiva mai. Anche il salvataggio con debounce (`saveData()` senza `immediate`) non ha chiamanti: tutti i 14 usi sono `immediate: true` | `src/lib/store.ts:45,59`, `src/lib/storage.ts:60-68`, `src/lib/storage.ts:327-333` | [L] | Togliere `_localDirty` e il ramo debounce. `saveData` diventa una funzione sincrona che restituisce `boolean` |
| M8 | **Documentazione non allineata al codice.** README: "hash/deep link compatibili con navigazione browser", ma l'app non aggiorna mai `location.hash`, quindi Indietro/Avanti non funzionano. Il modale "Info" dice che Discover "può pre-caricarli poco dopo l'avvio" (non è più vero). CHANGELOG: "1994 test" (oggi 1.596) e stripHtml "in shows.ts" (falso, vedi A1). Versione "1.2.1" scritta a mano nel modale | `README.md:205`, `src/main.ts:44-82`, `src/components/header.ts:93,101`, `CHANGELOG.md:14,18,49` | [V]/[L] | Allineare i testi. Per il routing: o aggiornare l'hash in `switchView`/`openShow`, o togliere la frase dal README. Versione presa da `package.json` tramite `define` di Vite |

### Gravità bassa (ma confonde o rallenta)

| # | Problema | Dove | Stato | Correzione proposta |
| --- | --- | --- | --- | --- |
| B1 | **Codice morto esportato**, usato solo dai test: `getStateSnapshot` (con tre "BUG fix" scritti per codice che non gira mai), `normalizeApiBase`, `dismissToast`, `destroyImageFallback`, il tipo `NextEpisode`. Ci sono anche re-export senza consumatori: `export { ApiError }` in tre file e `export { isStorageOK }` | `src/lib/store.ts:92`, `src/lib/constants.ts:9-29`, `src/components/toast.ts:47`, `src/components/imageFallback.ts:59`, `src/types.ts:90`, `src/lib/shows.ts:517`, `src/lib/discover.ts:359`, `src/components/search.ts:366`, `src/components/exportImport.ts:323` | [V] (analisi dei riferimenti) | Eliminarli insieme ai test che li coprono |
| B2 | **Rumore nei commenti**: 450 marcatori `BUG-A6-07`, `CRITICAL FIX (C5)`… e ~2.000 righe di commento su 8.700. Molte raccontano lo stato *precedente* del codice: è un changelog scritto dentro il sorgente | tutto `src/` (per es. `src/main.ts:1-23`, `src/lib/store.ts:1-26`) | [V] | Togliere gli ID e la storia; lasciare solo il *perché* dove non è ovvio. La storia resta in git |
| B3 | **Difese contro stati impossibili.** Dopo `canonicalizeDataDocument` i dati sono già canonici, eppure ogni funzione ricontrolla `show.seasons` null/array, `state.shows` non-array, `safeId` di Symbol/BigInt, `try/catch` attorno a un ciclo `for`. Il codice si allunga e nasconde le regole vere | `src/lib/shows.ts:153-157,180-183,340-343`, `src/lib/store.ts:96-107,217-234`, `src/lib/utils.ts:296-306` | [L] | Validare una sola volta al confine (load, import, risposta API) e fidarsi dei tipi all'interno |
| B4 | **Duplicazioni.** (a) La mappatura errore API → messaggio è ripetuta 3 volte. (b) `computeStatsAsync` e `computeCalendarAsync` sono quasi identiche (~60 righe ciascuna). (c) `normalizeShow` e `buildShowFromTvmaze` sanificano gli stessi campi con codice parallelo. (d) I modali di nota e tag collegano i listener con `setTimeout(…, 50)` copiato più volte | `src/lib/shows.ts:73-78,305-310`, `src/components/search.ts:189-196`, `src/worker/client.ts:95-218`, `src/lib/normalize.ts:89-327`, `src/views/showDetail.ts:539,613` | [L] | Un helper `apiErrorMessage(err)`; un `runInWorker(type, payload, fallback)` generico; `buildShowFromTvmaze` che produce un oggetto grezzo e lo passa a `normalizeShow`; `showModal` con una callback `onOpen` |
| B5 | **Guardia `_boundX` + `resetBoundGuard()` inutile**: il renderer la azzera sempre subito prima del bind, quindi il flag non blocca mai niente (a evitare i listener doppi è il `removeEventListener`) | `src/components/renderer.ts:135,177,186`, `src/views/showDetail.ts:41,402`, `src/views/discover.ts:30,227`, `src/views/calendar.ts:54,282` | [L] | Togliere flag e `resetBoundGuard`, lasciare solo il "rimuovi il vecchio handler, aggiungi il nuovo" |
| B6 | **Dipendenze fantasma**: `sw.ts` importa sei pacchetti `workbox-*` che non sono in `package.json` e arrivano solo come transitive di `vite-plugin-pwa` | `src/sw.ts:3-8` | [V] (`npm ls`) | Dichiararli in `devDependencies` alla stessa versione di `workbox-build` |
| B7 | **Toolchain fuori supporto**: ESLint 8 (non più supportato) con `.eslintrc` legacy, `typescript-eslint` 7; la config ESLint dichiara a mano ~40 globali già coperti da `env` e ignora `scripts/test-entry.ts`, che non esiste più | `.eslintrc.cjs:12-52,69`, `package.json` | [V] | Passare a ESLint 9 flat config + `typescript-eslint` 8 (risolve anche parte di A2) |
| B8 | **Quota localStorage sottostimata**: ogni salvataggio scrive due copie complete (principale e backup), quindi lo spazio finisce intorno a ~2,4 MB di documento, molto prima dell'avviso a 4.500 KB. Il backup, inoltre, è sempre solo lo stato *immediatamente precedente* (protegge da un passo solo) | `src/lib/storage.ts:96-119` | [S] | Calcolare la soglia sulla somma delle due chiavi, oppure tenere il backup solo prima delle operazioni distruttive (import/sostituzione) |
| B9 | **Ricerca: cliccare la riga di un risultato (non i pulsanti) aggiunge subito la serie come "In corso"**: un clic involontario modifica i dati. "Completata" dalla ricerca crea una serie completata con 0 episodi visti | `src/components/search.ts:332-336`, `src/lib/shows.ts:55` | [L] | Il clic sulla riga apre un'anteprima o non fa nulla; "Completata" segna anche tutti gli episodi come visti, oppure si toglie |
| B10 | **Notifiche**: con `airdate` solo come data, "1 ora prima" significa le 23:00 del giorno precedente; a ogni cambio di stato tutti i timer vengono ricreati e viene stampato un `console.warn` usato come log informativo | `src/lib/notifications.ts:176-183,228-230` | [L] | Salvare `airstamp` da TVMaze, oppure notificare la mattina del giorno di uscita; togliere il log |
| B11 | **Hook di test nel codice di produzione** (`_resetXForTesting` in 5 moduli, flag globali `window.__ploppytvInit`, `__ploppytvSearchDocClickHandler`) introdotti per far funzionare `vi.resetModules()` | `src/main.ts:224-226`, `src/components/search.ts:348-363`, `src/lib/i18n.ts:122` ecc. | [L] | Restano finché la suite non viene riorganizzata (fase 5); poi si possono semplificare |
| B12 | **Artefatti nel repository**: un video `.webm` da 1 MB non referenziato da nessuna parte; 31 branch remoti `audit/*`, `fix/*` già fusi; `manualChunks` per un file di 1,9 kB; `tsconfig` include `vitest/globals` mentre Vitest ha `globals: false` | `screenshots/Video/…webm`, `vite.config.ts:16-19`, `tsconfig.json:24` | [V] | Rimuovere video e branch fusi (dopo conferma), togliere `manualChunks` e il tipo `vitest/globals` |

### Test: valutazione complessiva [V]

- **Volume sproporzionato**: 31.000 righe di test per 8.700 di sorgente. 30 file su 49 si chiamano `probe_aN`/`probe_x`, cioè sono organizzati per "agente che li ha scritti" e non per modulo. `saveData` è testata in 10 file, `normalizeShow` in 9, `safeId` in 8.
- **Testano soprattutto difese contro input impossibili** (Symbol, BigInt, `seasons: null` dopo la canonicalizzazione…) e congelano i dettagli di implementazione con molti `vi.mock` (fino a 8 per file). Intanto **non hanno trovato** A1 (note alterate), M1 (calendario) né M2 (Discover): mancano test sul comportamento visto dall'utente.
- **Residui di altri ambienti**: 7 file contengono `// Run: cd /home/z/my-project/PloppyTV …`; un test si chiama "(informational)" e documenta un comportamento invece di verificarlo (`tests/probe_storage.test.ts:770`).
- Non ho trovato test vuoti o `expect(true).toBe(true)`: i test verificano davvero qualcosa, solo spesso la cosa sbagliata.

---

## 3. Piano di pulizia

In ordine dal più sicuro e utile al più invasivo. Ogni fase si chiude con `typecheck`, `lint`, `test`, `build` verdi.

| Fase | Contenuto | Rischio | Sforzo |
| --- | --- | --- | --- |
| **1. Sbloccare CI e ambiente** | A3 (`engines`, `.nvmrc`, `--no-webstorage` nella config Vitest), A2 (aggiornare `vite`/`vitest` semver-compatibili + `typescript-eslint` 8 + `lint-staged` 17; se `vite-plugin-pwa` 2 dà problemi, audit `--omit=dev` come ripiego), B6 (dichiarare `workbox-*`) | Basso | 0,5–1 giorno |
| **2. Bug che toccano i dati** | A1 (note/tag), M4 (merge import), M6 (`beforeunload`), M7 (rimuovere `_localDirty` + debounce), ciascuno con un test di regressione a livello di comportamento | Basso-medio | 1 giorno |
| **3. Bug funzionali visibili** | M1 (calendario/notifiche per data di uscita), M2 (pagine Discover dinamiche), B9, B10 | Medio | 1–1,5 giorni |
| **4. Rimozione codice morto e rumore** | B1, B2 (via gli ID `BUG-xx` e la storia nei commenti), B5, B12, B7 (ESLint 9 flat config). Nessun cambio di comportamento | Basso (meccanico) | 1–1,5 giorni |
| **5. Riorganizzazione dei test** | Unire i `probe_*` in un file per modulo, eliminare i doppioni e i test su input impossibili, aggiungere test di flusso (aggiungi serie → segna visto → ricarica → export/import). Tenere invariate le soglie di coverage o ridefinirle in modo esplicito. Poi semplificare B11 | Medio (servono attenzione e coverage come rete) | 2–3 giorni |
| **6. Semplificazioni strutturali** | B3 (validare solo ai confini), B4 (deduplicare worker client, errori API, normalize), M3 (completare l'i18n o dichiararla parziale), M8 (routing con hash reale + allineare README/CHANGELOG), B8 | Medio-alto | 2–4 giorni |
| **7. (Opzionale) Evoluzione dello schema** | M5: `watchedAt` sugli episodi (schema v3 con migrazione) per un Year-in-Review corretto | Medio | 1 giorno |

Totale indicativo: **~9–13 giorni** di lavoro per tutto; le fasi 1–3 (≈ 3 giorni) risolvono tutto ciò che oggi rompe qualcosa o fa perdere dati.

> Note sull'ambiente lasciato: ho installato `node_modules/` con `npm ci` (ignorato da git) e generato `dist/` e `coverage/` durante le verifiche, che poi ho rimosso. Gli script di prova usati (A1, M1, Discover) sono nello scratchpad della sessione, fuori dal repository.

---

## 4. Esito dell'esecuzione (18 novembre 2026)

Tutte e 7 le fasi sono state eseguite sul branch `cleanup/analisi-2026-11`, un commit per fase (la fase 6 in tre commit). Il branch non è ancora pubblicato su GitHub.

| | Prima | Dopo |
| --- | --- | --- |
| Test su Node 26 | 156 falliti su 1.596 | 1.301/1.301 verdi (verificato anche su Node 22.23.5) |
| Audit dipendenze di produzione | 0 (ma la CI falliva sull'audit completo) | 0; audit di sviluppo informativo in CI |
| Righe di sorgente / di test | 8.737 / ~31.000 | 8.062 / 21.596 |
| Marcatori `BUG-xx` in `src/` | ~450 | 0 |
| Coverage (statements / branches) | 94,2 % / 89,1 % | 95,1 % / 89,5 % (soglie invariate) |
| Chiavi i18n usate / definite | ~58 / 188 | tutte usate, IT ed EN allineate |

Esito per problema: A1, A2, A3, M1–M8 e B1–B10 risolti. Di B11 (hook di test nel codice) e B12 (artefatti) restano i punti elencati sotto.

### Cosa resta aperto

- **Advisory di sviluppo non risolvibili oggi.** `picomatch` ≤ 4.0.7 è segnalato e non esiste ancora una versione corretta. Riguarda solo gli strumenti di build e test, non l'app pubblicata, e in CI non blocca.
- **Branch remoti già fusi** (31 `audit/*`, `fix/*`, …): non li ho cancellati perché è un'operazione sul repository GitHub.
- **Hook di test nel codice di produzione** (B11): `_resetXForTesting` e i flag globali su `window` sono rimasti, perché servono ancora a più file di test.
- **Titoli dei test**: molti `describe` ereditati dai vecchi file probe contengono ancora ID come `BUG-A6-07`. È cosmetico, l'ho lasciato.
- **Nomi delle chiavi i18n** generate automaticamente: sono slug italiani (es. `io.esportaBackup`). Funzionano, ma rinominarle sarebbe più leggibile.
- **Versione**: `package.json` è ancora 1.2.1. Lo schema dati 3 è una modifica ai dati salvati: al rilascio conviene passare almeno a 1.3.0.
- **Verifica nel browser**: tutto è verificato con typecheck, lint, build e i test jsdom (compresi interfaccia inglese, routing e flusso completo). L'app non è stata provata a mano in un browser vero.
