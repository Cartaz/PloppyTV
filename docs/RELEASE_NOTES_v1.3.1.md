# PloppyTV v1.3.1 — Correzioni dopo la 1.3.0

**Tag:** `v1.3.1`
**Date:** novembre 2026
**Reference commit:** see [releases](https://github.com/Cartaz/PloppyTV/releases/tag/v1.3.1)
**Data compatibility:** invariata rispetto alla 1.3.0 (schema dati 3), nessuna migrazione

## Summary

Release di manutenzione. Corregge due difetti emersi provando a mano la 1.3.0 appena pubblicata e completa la pulizia interna iniziata con la versione precedente. I dati salvati non cambiano.

## 🐛 Correzioni

- **Il poster del dettaglio serie non genera più errori.** A ogni apertura l'app cercava una versione grande del poster a un indirizzo che sul CDN di TVMaze non esiste: la richiesta falliva (404) e solo dopo veniva caricato il poster normale. Ora viene caricato subito il poster normale, quello che già vedevi, senza la richiesta a vuoto.
- **Lo stato della serie è tradotto.** Il badge mostrava il valore originale di TVMaze in inglese ("ENDED", "Running") anche nell'interfaccia italiana; ora appare "Conclusa", "In corso", "Da definire" o "In sviluppo". Gli stati che l'app non conosce restano come li fornisce TVMaze.

## 📸 Documentazione

- Il README mostra finalmente **screenshot reali** dell'app (dashboard, dettaglio serie, Scopri, statistiche) al posto dell'immagine segnaposto.
- Aggiunte in `docs/` le note della 1.3.0; creato il tag `v1.2.1` sul commit di rilascio di quella versione.

## 🔧 Dettagli tecnici

- **Niente codice dedicato ai test nell'app**: tastiera, notifiche, fallback delle immagini e ricerca restituiscono la propria funzione di cleanup (`initX()` → `() => void`) invece di esporre funzioni `_resetXForTesting`; il reset dei filtri della libreria è `clearLibraryFilters()`, usato anche dal pulsante "Cancella filtri"; rimossi i flag globali su `window` (resta solo l'helper di debug attivo in sviluppo).
- **Traduzioni**: le 106 chiavi generate in automatico nella 1.3.0 hanno nomi descrittivi (es. `io.exportTitle`, `calendar.noEpisodesWeek`); il test di copertura delle traduzioni continua a verificare che ogni chiave usata esista in italiano e in inglese.
- **Test**: titoli e commenti senza le sigle `BUG-xx`/`FIX-xx` (356 occorrenze). 1.291 test; i 10 in meno verificavano funzioni rimosse o input impossibili. Soglie di coverage invariate.
- Dettaglio delle modifiche nella [PR #14](https://github.com/Cartaz/PloppyTV/pull/14) e nel [CHANGELOG](https://github.com/Cartaz/PloppyTV/blob/v1.3.1/CHANGELOG.md).

**Confronto completo**: https://github.com/Cartaz/PloppyTV/compare/v1.3.0...v1.3.1
