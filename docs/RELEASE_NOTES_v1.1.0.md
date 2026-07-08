# PloppyTV v1.1.0 — Fondamenta & igiene del progetto

**Tag:** `v1.1.0`
**Data:** Luglio 2026
**Commit di riferimento:** vedi [releases](https://github.com/Cartaz/PloppyTV/releases/tag/v1.1.0)
**Compatibilità dati:** 100% con v1.0.0 (nessuna migrazione necessaria)

## Riepilogo

Questa release conclude la **fase P1 della roadmap hobby**: tutti i 7 item "fondamenta & igiene del progetto" sono completati. L'obiettivo era colmare i gap bloccanti per poter condividere l'app con conoscenti in buona fede — niente più "All rights reserved" implicito, niente più regressioni silenziose, niente più "bozza" come scusa.

Nessuna nuova feature utente in questa release: il focus è interamente su tooling, documentazione, licenza e test. Le feature P2 (rating episodi, note private, tag, search avanzata, keyboard shortcuts, i18n) arriveranno nella prossima major.

## Cosa è cambiato

### ✅ Aggiunto

- **Licenza MIT** (`LICENSE`) — il codice è ora ufficialmente MIT, fork-able e reuse-able con attribuzione
- **Privacy policy formale** (`PRIVACY.md`) — linkata dal modal "Informazioni" dentro l'app
- **ESLint + Prettier + Husky** — pre-commit hook con `lint-staged` blocca commit con errori
- **Vitest + 64 test core** — coverage 31% sui moduli critici (`normalize.ts`, `utils.ts`, `store.ts`)
- **`CONTRIBUTING.md`** — guida completa per contributor
- **README arricchito** — badge, screenshot placeholder, sezioni test/privacy/roadmap
- **Issue templates** (Bug Report + Feature Request) e **PR template**
- **CI estesa** — la pipeline ora esegue typecheck + lint + format check + test su ogni PR

### 🔧 Modificato

- Versione bumped da 2.0.0 a 1.1.0 (allineamento con tag GitHub Stable = v1.0.0)
- Modal "Informazioni": aggiunti link a Privacy Policy, Contributing, Licenza
- CI: aggiunti job `lint` e `test` (in precedenza solo typecheck + build)

### 🗑️ Rimosso

- `console.log` da `src/main.ts` (warning ESLint `no-console`)

## Roadmap status

| Fase | Stato | Note |
| --- | --- | --- |
| **P1** — Fondamenta & igiene | ✅ **Completata in v1.1.0** | Tutti i 7 item chiusi |
| **P2** — Quality of life | 🚧 Prossima | Rating, note, tag, search avanzata, keyboard shortcuts, i18n |
| **P3** — Sync multi-device | ⏳ Pianificata | Google Drive / iCloud / Dropbox, opt-in |
| **P4** — AI e discovery | ⏳ Pianificata | LLM esterni con API key utente, default off |
| **P5** — Bonus | ⏳ Opzionale | Movies tracking, achievements, widget iOS, tema custom |

La regola d'oro della roadmap resta: **se una fase ti stressa, salta alla successiva**. P1 era prerequisito; da P2 in poi è tutto bonus.

## Metriche

- **Test**: 64 passing, 0 failing
- **Coverage**: 31.27% statements, 85.96% branches, 46.15% functions (soglia minima 30% ✓)
- **Lint**: 0 errori, 0 warning
- **Build**: 39.40 KB main chunk (13.71 KB gzip), 28 precache entries (158.22 KB)
- **Dipendenze**: +12 devDependencies per tooling, 0 runtime dependencies nuove

## Upgrade

### Da v1.0.0

Nessuna azione richiesta. I dati in `localStorage` (`ploppytv_data_v1`) sono identici e compatibili. L'app si aggiorna automaticamente al prossimo avvio grazie al Service Worker; un toast offrirà di applicare l'update immediatamente.

### Da versione originale (pre-v1.0)

Esporta un backup JSON dalla vecchia versione, poi importalo nella nuova. La struttura dati è compatibile.

## Asset della release

- **Source code**: zip e tar.gz generati automaticamente da GitHub
- **Build statica** (opzionale): disponibile come asset se la CI la produce; in caso contrario, buildable localmente con `npm run build`

## Prossimi passi

La fase P2 ("Quality of life quotidiana") è il prossimo blocco. Tema: feature che migliorano l'uso quotidiano senza richiedere architettura nuova. Sintesi degli item previsti:

- Rating 5★ per episodio + media stagione
- Note private per episodio (campo testo, max 500 char)
- Tag personalizzabili per serie ("da rivedere", "con Alice", "estate 2026")
- Search avanzata nella tua libreria (genere, status, rating ≥ N, network, anno)
- "Rivedi un episodio casuale" (suggerisce un episodio 5★ random)
- Keyboard shortcuts (`/` focus search, `g d` dashboard, `?` cheat sheet)
- i18n IT + EN
- Statistiche Year-in-Review
- Notifiche push per nuovi episodi (PWA installata)

Tempistica stimata: 8 settimane. Stop condition applicabile: se P2 stressa, salta a P3 (sync multi-device, il vero salto di qualità vs TV Time).

## Ringraziamenti

PloppyTV è "vibe coded" con il supporto del modello GLM 5.2 di Z.ai. Questa release v1.1.0 è stata generata in collaborazione con un assistente AI che ha curato la struttura del progetto, i test e la documentazione. Il codice è pubblico e audit-able su [GitHub](https://github.com/Cartaz/PloppyTV).
