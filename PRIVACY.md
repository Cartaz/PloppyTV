# Privacy Policy — PloppyTV

**Ultimo aggiornamento:** Luglio 2026

PloppyTV è una PWA (Progressive Web App) local-first per il tracking personale di serie TV. Questa pagina descrive in modo trasparente quali dati vengono raccolti, dove vengono salvati, cosa viene inviato a servizi esterni e come esercitare i propri diritti.

## TL;DR

- **Nessun account, nessun login, nessun server di backend.**
- **Tutti i tuoi dati restano nel tuo browser** (localStorage). Non vengono mai inviati a nessun server controllato dall'autore di PloppyTV.
- Le uniche chiamate di rete sono verso l'API pubblica di **TVMaze** per i metadati delle serie TV (ricerche, poster, episodi, calendario).
- **Nessun tracking, nessun analytics, nessun cookie di terze parti.**
- Disinstallare l'app cancella tutti i dati. È disponibile anche una funzione "Reset" 1-click.

## 1. Dati raccolti e memorizzati

PloppyTV memorizza nel `localStorage` del tuo browser i seguenti dati, inseriti o generati da te durante l'utilizzo:

| Categoria             | Esempio                                                                           | Dove                          |
| --------------------- | --------------------------------------------------------------------------------- | ----------------------------- |
| Serie TV tracciate    | ID TVMaze, stato (in visione / da vedere / completata), episodi visti             | `localStorage`                |
| Metadati delle serie  | Nome, poster, generi, rete, data di premiere, riassunto (tutti forniti da TVMaze) | `localStorage` (cache locale) |
| Impostazioni UI       | Ultima vista aperta, offset calendario, tab "Scopri" attiva                       | `localStorage`                |
| Timestamp di modifica | `savedAt` usato per il multi-tab sync via CAS                                     | `localStorage`                |

Nessun dato personale (nome, email, posizione, IP) viene raccolto o salvato. Non esiste un sistema di autenticazione, quindi non c'è modo di associare i dati a una tua identità.

## 2. Dati inviati a servizi esterni

### 2.1 TVMaze (`api.tvmaze.com`, `static.tvmaze.com`)

PloppyTV usa l'API pubblica gratuita di TVMaze per recuperare metadati delle serie TV. Le chiamate vengono effettuate nei seguenti casi:

- **Ricerca di una serie** tramite la search box → TVMaze riceve il termine di ricerca che hai digitato.
- **Apertura del dettaglio di una serie** → TVMaze riceve l'ID numerico della serie per recuperare stagioni ed episodi.
- **Caricamento della tab "Scopri"** → TVMaze riceve richieste paginate di elenchi di serie popolari/recenti.
- **Caricamento del calendario** → i metadati degli episodi sono già in cache locale; nessuna chiamata aggiuntiva se i dati sono già presenti.

Le risposte di TVMaze vengono **cached localmente** dal Service Worker (Workbox) per ridurre il traffico di rete. Il traffico verso TVMaze è soggetto alla [privacy policy di TVMaze](https://www.tvmaze.com/privacy).

### 2.2 Altri servizi

Nessuno. In particolare:

- **Nessun Google Analytics, Plausible, PostHog o simile.**
- **Nessun pixel di tracciamento marketing.**
- **Nessun SDK di social network.**
- **Nessun servizio di crash reporting** che invii dati a server terzi. Gli errori vengono solo stampati nella `console` del browser.

In futuro, le versioni P4 della roadmap potranno introdurre funzionalità AI opzionali (LLM esterni). Saranno sempre **disabilitate di default** e attivabili solo con inserimento esplicito di una API key da parte dell'utente. Questa policy sarà aggiornata prima di qualsiasi rilascio con tali feature.

## 3. Cookie

PloppyTV **non utilizza cookie**. L'autenticazione e la sessione non sono necessarie perché non esiste un backend.

## 4. LocalStorage e persistenza

I dati sono salvati nella chiave `ploppytv_data_v1` del `localStorage` del browser, con un backup automatico in `ploppytv_data_backup`. Dimensione tipica: 50-500 KB, limite pratico ~5 MB (browser-dependent).

In modalità privata/incognito del browser, `localStorage` può non essere disponibile: in quel caso l'app passa in modalità in-memory e i dati vengono persi alla chiusura della scheda.

## 5. Condivisione dei dati

I tuoi dati **non vengono mai condivisi** con terzi. Puoi esportare un backup JSON manuale tramite il pulsante "Esporta" nell'header: quel file è sotto il tuo pieno controllo e puoi condividerlo come preferisci.

La funzione "Importa" legge esclusivamente file selezionati esplicitamente da te. Nessun dato viene letto da altre fonti.

## 6. Multi-device

PloppyTV non implementa (al momento) alcun sistema di sincronizzazione cloud. Per usare gli stessi dati su più dispositivi, esporta il backup JSON da un dispositivo e importalo sull'altro. Le versioni P3 della roadmap introdurranno sync opzionale via cloud storage dell'utente (Google Drive / iCloud / Dropbox) con consenso esplicito.

## 7. I tuoi diritti (GDPR)

In quanto applicazione senza backend e senza raccolta di dati personali, l'esercizio dei diritti previsti dal GDPR (artt. 15-22) è diretto e immediato:

- **Diritto di accesso**: i tuoi dati sono visibili in DevTools → Application → Local Storage.
- **Diritto alla cancellazione ("diritto all'oblio")**: usa la funzione "Reset dati" nelle Impostazioni, oppure cancella i dati di navigazione del sito. La cancellazione è immediata e irrevocabile.
- **Diritto alla portabilità**: usa "Esporta" per ottenere un file JSON con tutti i tuoi dati.
- **Diritto di rettifica**: modifica i dati direttamente nell'app (segna/sposta episodi, elimina serie).

Poiché non conserviamo alcun dato sui nostri server, non esiste un "titolare del trattamento" nel senso classico: il titolare dei dati sei tu, sul tuo dispositivo.

## 8. Sicurezza

I dati in `localStorage` sono accessibili solo a script eseguiti nello stesso origin della PWA. L'applicaizone sanitizza tutti gli input provenienti da TVMaze e da file JSON importati (strip HTML, validazione ID, clamp numerici) per prevenire XSS e corruzione dello stato.

La roadmap P1 introduce ESLint, Prettier, Husky pre-commit e una suite Vitest con copertura sui moduli critici (`normalize.ts`, `utils.ts`, `store.ts`) per prevenire regressioni di sicurezza.

## 9. Modifiche a questa policy

Eventuali modifiche saranno pubblicate in questa stessa pagina con un nuovo "Ultimo aggiornamento". Trattandosi di un progetto local-first senza meccanismi di notifica push per policy update, ti invitiamo a consultare questa pagina periodicamente se hai interesse a restare informato.

## 10. Contatti

Per domande sulla privacy, apri una issue su [GitHub](https://github.com/Cartaz/PloppyTV/issues) o scrivi all'autore tramite il profilo GitHub `@Cartaz`.

## 11. Fonti esterne

- [Privacy policy di TVMaze](https://www.tvmaze.com/privacy) — l'unico servizio terzo contattato dall'app.
- [MDN: Web Storage API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API) — documentazione tecnica su `localStorage`.
- [GDPR, Regolamento UE 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj) — testo completo del regolamento.
