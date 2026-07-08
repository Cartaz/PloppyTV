# Contribuire a PloppyTV

Grazie per l'interesse nel contribuire a PloppyTV! Questo progetto è un hobby personale mantenuto da [Cartaz](https://github.com/Cartaz), ma ogni contributo — bug report, fix, feature, traduzioni, documentazione — è benvenuto.

Questa guida descrive come setuppare l'ambiente, quali convenzioni seguire e come proporre una modifica. Leggila prima di aprire la prima PR: aiuta a ridurre i round-trip di review.

## 1. Prerequisiti

- **Node.js 18+** (consigliato 20 LTS). PloppyTV usa Vite 5 e TypeScript 5; versioni più vecchie di Node possono non supportare tutte le feature ECMAScript usate.
- **npm 9+** (incluso con Node 18+). Non usiamo pnpm/yarn per mantenere un solo lockfile.
- Un editor con supporto TypeScript e ESLint (VS Code consigliato, ma qualsiasi editor va bene).

Verifica la tua versione di Node:

```bash
node --version   # v18.x o superiore
npm --version    # 9.x o superiore
```

## 2. Setup del progetto

```bash
# 1. Forka la repo su GitHub, poi clona il tuo fork
git clone https://github.com/<tuo-username>/PloppyTV.git
cd PloppyTV

# 2. Aggiungi l'upstream per sincronizzarti con il repo principale
git remote add upstream https://github.com/Cartaz/PloppyTV.git

# 3. Installa le dipendenze
npm install

# 4. Avvia il dev server
npm run dev      # http://localhost:5173
```

Il primo `npm install` attiva anche `husky` (tramite lo script `prepare`) per installare i git hook pre-commit. Se per qualche motivo i hook non sono attivi, puoi verificarli con `ls .husky/`.

## 3. Script disponibili

| Script | Scopo |
| --- | --- |
| `npm run dev` | Dev server Vite su http://localhost:5173 con HMR |
| `npm run build` | Type-check + build di produzione in `dist/` |
| `npm run preview` | Serve la build di produzione su http://localhost:4173 |
| `npm run typecheck` | Solo `tsc --noEmit`, veloce per validare i tipi |
| `npm run lint` | ESLint su tutti i file `.ts/.js/.cjs/.mjs` con `--max-warnings=0` |
| `npm run lint:fix` | ESLint con `--fix` (auto-correzione dove possibile) |
| `npm run format` | Prettier su tutti i sorgenti |
| `npm run format:check` | Prettier in modalità check (CI) |
| `npm run test` | Esegue la suite Vitest una volta |
| `npm run test:watch` | Vitest in watch mode durante lo sviluppo |
| `npm run test:coverage` | Vitest + coverage report (soglia minima 30%) |

## 4. Struttura del progetto

```
src/
├── main.ts              # Entry point: init moduli + register SW
├── types.ts             # Tipi condivisi UI ↔ worker
├── styles/main.css      # Tutto il CSS in un unico file
├── lib/                 # Logica pura (testabile senza DOM)
│   ├── constants.ts     # API_BASE, chiavi storage, config
│   ├── utils.ts         # Helper puri (date, escape, watched count)
│   ├── store.ts         # State store con subscribe + mutators
│   ├── storage.ts       # localStorage + backup + multi-tab sync
│   ├── api.ts           # Client TVMaze con timeout/abort
│   ├── normalize.ts     # Validazione + sanitizzazione show
│   ├── shows.ts         # Azioni: add/remove/move/toggle episode
│   └── discover.ts      # Fetch serie popolari + grouping per genere
├── worker/              # Web Worker per stats/calendar off-main-thread
│   ├── stats.worker.ts
│   └── client.ts        # Wrapper con fallback main-thread
├── components/          # UI components (DOM-bound)
│   ├── toast.ts, modal.ts, header.ts, search.ts,
│   ├── exportImport.ts, img.ts, imageFallback.ts, renderer.ts
└── views/               # Viste router (code-split, lazy-loadate)
    ├── dashboard.ts, showList.ts, showDetail.ts,
    ├── discover.ts, calendar.ts, stats.ts

tests/                   # Suite Vitest (spec dei moduli lib/)
```

**Principio guida:** tutto ciò che è logica pura vive in `src/lib/` ed è testabile senza jsdom. I componenti in `src/components/` e `src/views/` manipolano il DOM e sono più difficili da testare; preferiamo testare la logica, non il markup.

## 5. Convenzioni di codice

### 5.1 TypeScript strict

Il progetto usa `strict: true` plus `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noImplicitReturns`. Questo significa:

- Niente variabili/funzioni non usate (prefix con `_` per ignorare intenzionalmente).
- Tutti i parametri devono essere usati o prefissati con `_`.
- Niente `any` esplicito senza giustificazione (lint warn). Se serve, aggiungi un commento che spiega perché.
- Imports di soli tipi con `import type` o `import { type Foo }`.

### 5.2 Formattazione (Prettier)

La config è in `.prettierrc.json`. Le regole principali:

- Single quote, trailing comma `all`, print width 120, 2 spazi, LF.
- Arrow function sempre con parentesi: `(x) => x`.
- Per Markdown: `printWidth: 100`, `proseWrap: 'preserve'`.

**Non formattare manualmente**: lascia che Prettier faccia il lavoro. Il pre-commit hook (`lint-staged`) formatta automaticamente i file modificati prima del commit.

### 5.3 ESLint

La config è in `.eslintrc.cjs`. Estende `eslint:recommended` + `@typescript-eslint/recommended` + `prettier` (per disabilitare le regole in conflitto con Prettier). Regole custom:

- `no-console`: warn (solo `console.warn` e `console.error` permessi).
- `eqeqeq`: smart.
- `prefer-const`, `no-var`: warn.

`npm run lint` usa `--max-warnings=0`, quindi anche un warning blocca il pre-commit hook. Se hai un warning legittimo, aggiungi un commento `// eslint-disable-next-line <rule>` con spiegazione.

### 5.4 Naming

- **File**: `camelCase.ts` per moduli, `PascalCase.ts` per componenti React-style (ma qui non ne abbiamo). I file di test: `<nome>.test.ts`.
- **Funzioni/variabili**: `camelCase`.
- **Tipi/interfacce**: `PascalCase`.
- **Costanti**: `UPPER_SNAKE_CASE` per valori primitivi (`API_BASE`), `camelCase` per oggetti/array.
- **CSS classi**: `kebab-case`.

### 5.5 Convenzioni commit

Usiamo [Conventional Commits](https://www.conventionalcommits.org/) semplificato:

```
<type>: <descrizione in italiano, lowercase, presente>

types: feat | fix | refactor | test | docs | style | perf | chore | ci
```

Esempi:

```
feat: aggiunta sezione "Year in Review" nella vista stats
fix: risolto race condition in search.ts (H11)
refactor: estratto helper makeShow in tests/helpers.ts
test: aggiunti 5 test per safeId (utils.ts)
docs: aggiornato README con sezione screenshots
chore: bump vitest a 1.6.0
```

- Una riga, max 72 caratteri per il subject. Se serve più contesto, aggiungi un body separato da riga vuota.
- Riferimenti a issue/fix precedenti: usa `(H11)` o `(#42)` tra parentesi alla fine.

## 6. Pre-commit hook

Il file `.husky/pre-commit` esegue `lint-staged`, che a sua volta:

1. Esegue `eslint --fix` + `prettier --write` sui file `.ts/.tsx/.js/.cjs/.mjs` modificati.
2. Esegue `prettier --write` su `.json/.md/.css/.html` modificati.

Se ESLint trova errori non auto-fixabili, il commit viene rifiutato. Correggi gli errori e ritenta.

Per saltare il hook una tantum (NON raccomandato, solo per emergenze): `git commit --no-verify`. Le PR che usano `--no-verify` vengono flaggate in review.

## 7. Workflow di una PR

1. **Crea un branch** partendo da `main`:
   ```bash
   git checkout -b feat/mia-feature
   ```
2. **Sviluppa** in modo incrementale. Fai commit piccoli e frequenti.
3. **Aggiungi test** per ogni nuova funzione in `src/lib/`. Per UI, almeno un test smoke che verifica che il modulo si carichi senza throw.
4. **Verifica localmente** prima di pushare:
   ```bash
   npm run typecheck
   npm run lint
   npm run test
   npm run build
   ```
   Se uno di questi fallisce, la CI bloccherà la PR.
5. **Pusha** sul tuo fork:
   ```bash
   git push -u origin feat/mia-feature
   ```
6. **Apri la PR** su GitHub verso `Cartaz/PloppyTV:main`. Usa il template di PR (se configurato) e includi:
   - Cosa cambia e perché.
   - Issue collegate (`Closes #42`).
   - Screenshot se la PR tocca la UI.
   - Breaking changes, se presenti.

### 7.1 Review

Le PR vengono riviste dall'autore del progetto. I criteri principali:

- **Type safety**: nessun `any` non giustificato, nessun cast pericoloso.
- **Test**: nuova logica in `src/lib/` deve avere test. Coverage non deve scendere sotto il 30%.
- **Performance**: evita re-render inutili, attenzione a listener non rimossi, preferisci event delegation.
- **Privacy**: nessuna chiamata network aggiuntiva verso servizi non documentati in `PRIVACY.md`.
- **A11y**: keyboard navigation, ARIA dove appropriato, contrasto colore.

Il tempo di review tipico è 1-7 giorni. Se non hai risposta dopo una settimana, pinga pure con un commento.

## 8. Bug report e feature request

Apri una [issue su GitHub](https://github.com/Cartaz/PloppyTV/issues/new/choose) usando il template appropriato (Bug Report o Feature Request). I template sono in `.github/ISSUE_TEMPLATE/`.

### 8.1 Bug report

Includi sempre:

- **Versione di PloppyTV** (visibile in About → "Versione X.Y.Z").
- **Browser e OS** (es. "Chrome 126 su macOS 14").
- **PWA installata o usata via browser?**
- **Passi per riprodurre** (numero, non "fai questo e quello").
- **Comportamento atteso vs. attuale**.
- **Console errors/screenshots** se pertinenti.
- **È riproducibile dopo reload?** E dopo reset dati?

### 8.2 Feature request

Includi:

- **Problema che risolve** (non solo "sarebbe figa").
- **Soluzione proposta** (anche solo abbozzata).
- **Alternative considerate**.
- **Impatto sulla privacy** (chiamate network aggiuntive? nuovi dati salvati?).

Le feature devono rispettare i principi in `PRIVACY.md`: local-first, no backend, no account, no tracking. Richieste che violano questi principi verranno chiuse con spiegazione.

## 9. Traduzioni

Attualmente l'app è in italiano. La roadmap P2 introdurrà i18n IT + EN. Se vuoi contribuire con una traduzione, aspetta che il framework i18n sia mergiato (vedi issue #N quando disponibile) — tradurre stringhe sparse ora creerebbe conflitti.

## 10. Code of conduct

Sii civile. Questo è un progetto hobby, non un prodotto commerciale. Chiunque (maintainer, contributor, utente) merita rispetto. Comportamenti tossici (insulti, harassment, spam) portano a ban permanente senza preavviso.

Per il resto, vale la [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) come baseline.

## 11. Domande?

Apri una [Discussion su GitHub](https://github.com/Cartaz/PloppyTV/discussions) (se abilitate) o una issue con label `question`. Non scrivere email dirette all'autore: tutto passa per GitHub per mantenere traccia pubblica.

---

Grazie ancora per contribuire. PloppyTV è quello che è grazie alle persone che lo usano e lo migliorano.
