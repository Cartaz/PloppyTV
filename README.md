# PloppyTV — Tracker personale per serie TV (PWA)

App PWA per tracciare serie TV, episodi visti, calendario, statistiche. Dati salvati localmente (localStorage). API: TVMaze (gratuita, senza chiave).

## Stack tecnico

- **Vite 5** — bundler + dev server
- **TypeScript 5** — type safety, zero runtime overhead
- **Vanilla JS** (no React/Vue) — logica preservata dall'originale
- **vite-plugin-pwa** — Service Worker con Workbox (precache + runtime caching)
- **Web Worker** — calcolo statistiche e calendario off-main-thread
- **Code-splitting per vista** — Discover, Calendar, Stats, ShowDetail sono chunk separati lazy-loadati

## Struttura del progetto

```
ploppytv/
├── index.html                 # HTML entry (carica /src/main.ts)
├── vite.config.ts             # Config Vite + PWA
├── tsconfig.json
├── package.json
├── .github/workflows/
│   ├── ci.yml                 # type-check + build su PR
│   └── deploy.yml             # build + deploy su GitHub Pages
├── public/
│   ├── favicon.ico
│   └── icons/                 # icone PWA (192, 512, maskable, ...)
├── scripts/
│   └── test-entry.ts          # Re-export delle funzioni interne per test/stress-test manuali
└── src/
    ├── main.ts                # Entry point: init moduli + register SW
    ├── types.ts               # Tipi condivisi UI ↔ worker
    ├── vite-env.d.ts
    ├── styles/
    │   └── main.css           # Tutto il CSS (estratto dall'originale)
    ├── lib/
    │   ├── constants.ts       # API_BASE, chiavi storage, config discover
    │   ├── utils.ts           # Helper puri (date, escape, watched count)
    │   ├── store.ts           # State store con subscribe + mutators
    │   ├── storage.ts         # localStorage + backup + multi-tab sync
    │   ├── api.ts             # Client TVMaze con timeout/abort
    │   ├── normalize.ts       # Validazione + sanitizzazione show
    │   ├── shows.ts           # Azioni: add/remove/move/toggle episode
    │   └── discover.ts        # Fetch serie popolari + grouping per genere
    ├── worker/
    │   ├── stats.worker.ts    # Worker: computeStats + computeCalendar
    │   └── client.ts          # Wrapper con fallback main-thread
    ├── components/
    │   ├── toast.ts           # Toast notifications
    │   ├── modal.ts           # Modal dialog
    │   ├── header.ts          # Nav, sidebar mobile, badges
    │   ├── search.ts          # Search box TVMaze
    │   ├── exportImport.ts    # Backup JSON
    │   ├── img.ts             # imgTag() con data-fallback
    │   ├── imageFallback.ts   # Delegato globale fallback immagini
    │   └── renderer.ts        # Router viste con code-splitting
    ├── views/
    │   ├── dashboard.ts
    │   ├── showList.ts        # watching / towatch / completed
    │   ├── showDetail.ts
    │   ├── discover.ts
    │   ├── calendar.ts        # usa worker
    │   └── stats.ts           # usa worker
    └── sw.ts                  # Service Worker (Workbox injectManifest)
```

## Sviluppo

```bash
npm install
npm run dev          # http://localhost:5173
```

## Build di produzione

```bash
npm run build        # output in dist/
npm run preview      # serve dist/ su http://localhost:4173
```

## Deploy su GitHub Pages

Il workflow `.github/workflows/deploy.yml` è preconfigurato. Per deployare:

1. Crea un repo su GitHub e pusha il progetto
2. Vai in **Settings → Pages → Build and deployment → Source**: seleziona **GitHub Actions**
3. Al prossimo push su `main`, il workflow builda e pubblica automaticamente
4. L'URL sarà `https://<username>.github.io/<repo-name>/`

Il base path è configurato automaticamente dal workflow:
- Se il repo si chiama `<user>.github.io` → base `/`
- Altrimenti → base `/<repo-name>/`

Per deploy custom (es. dominio proprio), puoi sovrascrivere con variabile d'ambiente:
```bash
VITE_BASE_PATH=/mio-percorso/ npm run build
```

## Ottimizzazioni implementate rispetto all'originale

| Ottimizzazione | Effetto |
|---|---|
| Code-splitting viste | Carico iniziale -26% gzip (26.8KB → 19.8KB) |
| Web Worker per stats/calendar | UI non si blocca su liste grandi |
| vite-plugin-pwa (Workbox) | SW robusto con expiration plugin, cache separata per API/img |
| Event delegation globale | Un solo handler click sul main invece di centinaia di `onclick` inline |
| Image fallback delegato | Un handler `error` capture-phase invece di `onerror` per ogni img |
| TypeScript strict | Type safety senza runtime overhead |
| `preconnect` a TVMaze | -100-300ms TTI su prima visita |
| `loading="lazy"` ovunque | Risparmio banda iniziale |

## Affidabilità: fix da stress test

L'ultimo giro di sviluppo si è concentrato sulla robustezza dell'app in scenari reali (più tab aperte, worker che risponde in ritardo, SW che aggiorna in background, uso da tastiera/screen reader). In sintesi:

| Area | Problema risolto |
| --- | --- |
| **Storage multi-tab** | Scritture concorrenti tra tab diverse ora usano un controllo ottimistico (CAS su `savedAt`): se un'altra tab ha già salvato, la scrittura corrente viene rifiutata invece di sovrascrivere silenziosamente i dati |
| **Modali nidificate** | `modal.ts` ora gestisce uno **stack** di modali: aprire una modale da dentro un'altra non chiude più anche quella padre; aggiunti focus trap, `role="dialog"`, `aria-modal` e gestione ESC |
| **Web Worker (stats/calendar)** | Le richieste al worker portano un `id` di correlazione: risposte in ritardo da richieste precedenti non vengono più confuse con quella corrente; aggiunto `worker.onerror` per catturare errori di caricamento dello script |
| **Aggiornamento PWA** | Un nuovo Service Worker "in attesa" ora mostra un toast che permette di applicare subito l'update, invece di restare bloccato finché l'utente non chiude manualmente tutte le tab |
| **Routing con hash** | Gli shortcut PWA (`#dashboard`, `#discover`, `#calendar`) e i deep link a una serie (`#show/<id>`) ora vengono interpretati anche dopo il caricamento iniziale e supportano avanti/indietro del browser |
| **Ricerca TVMaze** | Corretta una race condition per cui i risultati di una ricerca precedente potevano sovrascrivere quelli di una più recente |
| **Normalizzazione dati** | Sanitizzazione più rigorosa dei dati importati/da API (percentuali di progresso e conteggi episodi ora sempre in un range valido, niente più `NaN`/negativi) |

## Novità recenti

- **Preload di "Scopri"** — al termine dell'avvio l'app carica in background (con un piccolo delay per non competere col primo render) le serie popolari e recenti da TVMaze, così quando l'utente apre la tab "Scopri" i dati sono già pronti o quasi
- **Statistiche più compatte** — le card della vista Stats sono state ridimensionate per mostrare più informazioni senza scroll eccessivo
- **Barra di completamento al 100%** — le barre di progresso (dashboard e dettaglio serie) diventano verdi quando una serie è completata, invece di restare del colore accento standard
- **Fallback immagini a catena** — il poster nel dettaglio serie prova prima la versione ad alta risoluzione, poi quella media, poi il placeholder testuale, invece di saltare direttamente al placeholder al primo errore

## Migrare dati dalla versione originale

La struttura dati `ploppytv_data_v1` in localStorage è **identica e compatibile**. Se avevi già la PWA originale installata e funzionante, i dati vengono automaticamente riconosciuti dalla nuova versione.

Per sicurezza: usa "Esporta" nella vecchia versione per creare un backup JSON, poi "Importa" nella nuova.
