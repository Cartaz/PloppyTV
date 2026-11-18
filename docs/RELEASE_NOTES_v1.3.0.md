# PloppyTV v1.3.0 — Pulizia completa e dati più affidabili

**Tag:** `v1.3.0`
**Date:** novembre 2026
**Reference commit:** see [releases](https://github.com/Cartaz/PloppyTV/releases/tag/v1.3.0)
**Data compatibility:** schema dati 3 (`Episode.watchedAt`); i dati degli schemi 1 e 2 si caricano senza conversione

## Summary

Questa versione mette ordine nel progetto e corregge comportamenti che facevano perdere dati o mostravano informazioni sbagliate. Lo **schema dei dati passa alla versione 3**: le date di visione vengono salvate e il Year-in-Review diventa preciso.

> ⚠️ **Prima di aggiornare, fai un backup con Esporta.** I dati esistenti si caricano senza conversione, ma una versione precedente dell'app aperta in un altro tab vedrà i nuovi dati in sola lettura finché non la ricarichi.

## 🐛 Correzioni

### I tuoi dati
- **Note e tag restano come li hai scritti.** Prima, dopo un ricaricamento, una nota come `2 < 3 > 1` diventava `2  1`, e `&amp;` diventava `&`.
- **"Unisci" nell'import non perde più nulla.** L'unione avviene episodio per episodio: un episodio è visto se lo è in almeno una delle due copie; voti e note locali hanno la precedenza e quelli del backup riempiono i vuoti; i tag vengono uniti. Prima un backup con più episodi visti sovrascriveva voti e note locali, e i tag del backup venivano ignorati.
- **Più tab aperti non si bloccano più a vicenda.** Chiudere un tab non riscrive più i dati: ogni modifica è già salvata nel momento in cui la fai.

### Calendario e notifiche
- **Il calendario mostra le uscite della settimana anche se sei indietro** con gli episodi precedenti. Prima mostrava solo il primo episodio non visto di ogni serie.
- **Le notifiche riguardano la prossima uscita** e arrivano alle 9:00 del giorno in cui esce, non alle 23:00 del giorno prima.

### Scopri e ricerca
- **"Ultimi arrivi" mostra davvero le serie nuove**: le pagine di TVMaze vengono individuate in automatico, invece di usare numeri di pagina fissi ormai superati.
- **Un clic sulla riga di un risultato di ricerca non aggiunge più la serie** per errore: per aggiungerla usa i pulsanti della lista.
- **"Completata" dalla ricerca segna come visti tutti gli episodi.**

### Navigazione e lingua
- **Indietro e Avanti del browser funzionano**, e un link a una serie (`#show/123`) la apre direttamente.
- **L'interfaccia in inglese è completa**: menu, messaggi, errori e tutte le viste. Prima buona parte restava in italiano.

## 🆕 Year-in-Review preciso

Gli episodi contano nell'**anno in cui li hai visti**, non in quello di uscita: se nel 2026 recuperi una serie del 2010, finisce nel tuo 2026. Gli episodi segnati come visti prima di questa versione non hanno una data: per loro si usa l'anno di uscita, e la vista dice quanti sono.

## 🔧 Dettagli tecnici

- **Schema dati 3**: `Episode.watchedAt` registra quando un episodio è stato segnato come visto. I documenti di schema 1 e 2 vengono accettati così come sono.
- **Ambiente di sviluppo**: Node 26 di riferimento (`.nvmrc`), minimo 22.22.1; la CI esegue i test su entrambe. I test passano anche su Node ≥ 25, dove prima ne fallivano 156.
- **Strumenti**: ESLint 9, typescript-eslint 8, vite-plugin-pwa 2, lint-staged 17; le dipendenze `workbox-*` sono dichiarate esplicitamente. L'audit della CI blocca sulle dipendenze di produzione (nessuna vulnerabilità) ed è informativo su quelle di sviluppo.
- **Pulizia del codice**: rimossi codice morto e i commenti `BUG-xx` (~450); i dati vengono validati una sola volta ai confini (caricamento, import, risposte API). Bilancio: −11.200 righe, +4.500.
- **Test**: suite riorganizzata per modulo (da ~31.000 a ~22.000 righe), con nuovi test sul flusso completo (aggiungi → segna → ricarica → esporta → importa), su testo ostile renderizzato in tutte le viste e sulla completezza delle traduzioni. 1.301 test, soglie di coverage invariate.
- Analisi completa e motivazioni in [`ANALISI.md`](https://github.com/Cartaz/PloppyTV/blob/v1.3.0/ANALISI.md); dettaglio delle modifiche nel [CHANGELOG](https://github.com/Cartaz/PloppyTV/blob/v1.3.0/CHANGELOG.md) e nella [PR #13](https://github.com/Cartaz/PloppyTV/pull/13).

**Confronto completo**: https://github.com/Cartaz/PloppyTV/compare/v1.2.1...v1.3.0
