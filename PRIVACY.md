# Privacy Policy — PloppyTV

**Ultimo aggiornamento:** 31 agosto 2026

PloppyTV è una PWA (Progressive Web App) local-first per il tracking personale di serie TV. Questa pagina descrive in modo trasparente quali dati vengono raccolti, dove vengono salvati, cosa viene inviato a servizi esterni e come esercitare i propri diritti.

## TL;DR

- **Nessun account, nessun login, nessun server di backend.**
- **Lo stato del tracker resta nel browser**: PloppyTV non ha account né un backend applicativo.
- L'app statica è ospitata su **GitHub Pages**; le connessioni al sito sono quindi soggette anche alle policy e ai log tecnici del provider di hosting.
- I metadati delle serie arrivano da **TVMaze**. La sezione Scopri contatta TVMaze solo quando la apri o chiedi esplicitamente di aggiornarla.
- **Nessun analytics o tracking aggiunto da PloppyTV e nessun cookie applicativo.**
- Per cancellare i dati locali usa gli strumenti del browser per cancellare i dati del sito; la sola disinstallazione della PWA non è trattata come garanzia di cancellazione cross-browser.

## 1. Dati raccolti e memorizzati

PloppyTV memorizza nel `localStorage` del tuo browser i seguenti dati, inseriti o generati da te durante l'utilizzo:

| Categoria             | Esempio                                                                           | Dove                          |
| --------------------- | --------------------------------------------------------------------------------- | ----------------------------- |
| Serie TV tracciate    | ID TVMaze, stato (in visione / da vedere / completata), episodi visti             | `localStorage`                |
| Metadati delle serie  | Nome, poster, generi, rete, data di premiere, riassunto (tutti forniti da TVMaze) | `localStorage` (cache locale) |
| Impostazioni locali   | Lingua, preferenza notifiche                                                       | `localStorage`                |
| Cache Scopri           | Elenchi popolari/recenti e timestamp di cache                                     | `localStorage`                |
| Timestamp di modifica | `savedAt` usato per il multi-tab sync via CAS                                     | `localStorage`                |
| Cache runtime          | Asset PWA, risposte API e poster                                                   | Cache Storage / Service Worker |

PloppyTV non chiede nome, email, posizione o altri dati identificativi e non possiede un sistema di autenticazione. Come per qualunque sito web, l'indirizzo IP e altri metadati di connessione possono essere trattati tecnicamente dai servizi contattati (hosting GitHub Pages e TVMaze) secondo le rispettive policy.

## 2. Dati inviati a servizi esterni

### 2.1 TVMaze (`api.tvmaze.com`, `static.tvmaze.com`)

PloppyTV usa l'API pubblica gratuita di TVMaze per recuperare metadati delle serie TV. Le chiamate vengono effettuate nei seguenti casi:

- **Ricerca di una serie** tramite la search box → TVMaze riceve il termine di ricerca che hai digitato.
- **Apertura del dettaglio di una serie** → TVMaze riceve l'ID numerico della serie per recuperare stagioni ed episodi.
- **Scopri** → quando apri la vista, PloppyTV carica il tab richiesto (popolari o recenti); ulteriori richieste avvengono quando cambi tab o usi "Aggiorna lista" se i dati non sono già disponibili in cache.
- **Caricamento del calendario** → usa normalmente gli episodi già presenti nello stato locale.

Le risposte API e i poster possono essere **cached localmente** dal Service Worker (Workbox) per ridurre traffico e latenza. Il traffico verso TVMaze è soggetto alla [privacy policy di TVMaze](https://www.tvmaze.com/privacy).

### 2.2 GitHub Pages

Se usi la versione pubblicata su GitHub Pages, i file della PWA vengono serviti dall'infrastruttura GitHub. PloppyTV non aggiunge analytics propri, ma le richieste HTTP necessarie a scaricare l'app transitano dal provider di hosting e sono soggette alla [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

### 2.3 Altri servizi integrati da PloppyTV

Nessuno. In particolare:

- **Nessun Google Analytics, Plausible, PostHog o simile.**
- **Nessun pixel di tracciamento marketing.**
- **Nessun SDK di social network.**
- **Nessun servizio di crash reporting** che invii dati a server terzi. Gli errori vengono solo stampati nella `console` del browser.

In futuro, le versioni P4 della roadmap potranno introdurre funzionalità AI opzionali (LLM esterni). Saranno sempre **disabilitate di default** e attivabili solo con inserimento esplicito di una API key da parte dell'utente. Questa policy sarà aggiornata prima di qualsiasi rilascio con tali feature.

## 3. Cookie

Il codice di PloppyTV non imposta cookie applicativi. L'autenticazione e una sessione lato server non sono necessarie perché non esiste un backend PloppyTV. I provider esterni restano soggetti alle proprie policy quando vengono contattati.

## 4. LocalStorage e persistenza

Lo stato principale è salvato nella chiave `ploppytv_data_v1` del `localStorage`, con backup automatico in `ploppytv_data_backup`. Preferenze e cache Scopri usano chiavi locali separate; il Service Worker usa inoltre Cache Storage per asset, API e poster. Le quote dipendono dal browser e dal dispositivo.

In modalità privata/incognito del browser, `localStorage` può non essere disponibile: in quel caso l'app passa in modalità in-memory e i dati vengono persi alla chiusura della scheda.

## 5. Condivisione dei dati

I tuoi dati **non vengono mai condivisi** con terzi. Puoi esportare un backup JSON manuale tramite il pulsante "Esporta" nell'header: quel file è sotto il tuo pieno controllo e puoi condividerlo come preferisci.

La funzione "Importa" legge esclusivamente file selezionati esplicitamente da te. Nessun dato viene letto da altre fonti.

## 6. Multi-device

PloppyTV non implementa (al momento) alcun sistema di sincronizzazione cloud. Per usare gli stessi dati su più dispositivi, esporta il backup JSON da un dispositivo e importalo sull'altro. Le versioni P3 della roadmap introdurranno sync opzionale via cloud storage dell'utente (Google Drive / iCloud / Dropbox) con consenso esplicito.

## 7. I tuoi diritti (GDPR)

In quanto applicazione senza backend e senza raccolta di dati personali, l'esercizio dei diritti previsti dal GDPR (artt. 15-22) è diretto e immediato:

- **Diritto di accesso**: i tuoi dati sono visibili in DevTools → Application → Local Storage.
- **Cancellazione dei dati locali**: cancella i dati del sito/PWA dalle impostazioni del browser. Questa operazione rimuove lo storage locale del relativo origin secondo il comportamento del browser.
- **Diritto alla portabilità**: usa "Esporta" per ottenere un file JSON con tutti i tuoi dati.
- **Diritto di rettifica**: modifica i dati direttamente nell'app (segna/sposta episodi, elimina serie).

PloppyTV non gestisce un database remoto dei tuoi dati del tracker. Per eventuali dati tecnici trattati dai servizi esterni contattati, valgono ruoli e condizioni descritti nelle rispettive privacy policy. Questa pagina descrive il comportamento tecnico del progetto e non sostituisce una valutazione legale.

## 8. Sicurezza

I dati in `localStorage` sono accessibili solo a script eseguiti nello stesso origin della PWA. L'applicazione sanitizza tutti gli input provenienti da TVMaze e da file JSON importati (strip HTML, validazione ID, clamp numerici) per prevenire XSS e corruzione dello stato.

La roadmap P1 introduce ESLint, Prettier, Husky pre-commit e una suite Vitest con copertura sui moduli critici (`normalize.ts`, `utils.ts`, `store.ts`) per prevenire regressioni di sicurezza.

## 9. Modifiche a questa policy

Eventuali modifiche saranno pubblicate in questa stessa pagina con un nuovo "Ultimo aggiornamento". Trattandosi di un progetto local-first senza meccanismi di notifica push per policy update, ti invitiamo a consultare questa pagina periodicamente se hai interesse a restare informato.

## 10. Contatti

Per domande sulla privacy, apri una issue su [GitHub](https://github.com/Cartaz/PloppyTV/issues) o scrivi all'autore tramite il profilo GitHub `@Cartaz`.

## 11. Fonti esterne

- [Privacy policy di TVMaze](https://www.tvmaze.com/privacy) — metadati e poster delle serie.
- [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) — hosting della versione GitHub Pages.
- [MDN: Web Storage API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API) — documentazione tecnica su `localStorage`.
- [GDPR, Regolamento UE 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj) — testo completo del regolamento.
