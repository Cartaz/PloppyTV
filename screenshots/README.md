# Screenshot reali di PloppyTV

Questa cartella conterrà gli screenshot ufficiali della PWA usati nel README e nelle release notes.

## Screenshot attuali

| File | Stato | Note |
| --- | --- | --- |
| `dashboard-placeholder.svg` | **Placeholder** | Mockup SVG generato per il README. Sostituire con screenshot reale. |

## Come generare gli screenshot reali

La roadmap P1 prevede 3-4 screenshot della PWA in azione: **Dashboard**, **Scopri**, **Calendario**, **Statistiche**. Procedura consigliata:

1. **Avvia la build di produzione** (non il dev server, per avere il tema corretto):
   ```bash
   npm run build
   npm run preview   # http://localhost:4173
   ```
2. **Apri Chrome/Edge** su `http://localhost:4173` a viewport 1280×720 (Desktop) o 390×844 (mobile).
3. **Importa un dataset di esempio** (3-5 serie con stati misti) per avere screenshot realistici anziché una libreria vuota.
4. **Naviga ogni vista** e cattura con:
   - Chrome DevTools → Cmd/Ctrl+Shift+P → "Capture full size screenshot", oppure
   - Strumento nativo OS (Cmd+Shift+4 su macOS, Win+Shift+S su Windows, `gnome-screenshot` su Linux).
5. **Salva come PNG** (non JPG, per evitare artefatti su testi) con nome `<vista>-1280x720.png` o `<vista>-mobile.png`.
6. **Ottimizza** con `optipng` o [squoosh.app](https://squoosh.app): target < 200 KB per immagine.

## Screenshot raccomandati per il README

| Nome file | Vista | Viewport | Scopo |
| --- | --- | --- | --- |
| `dashboard-desktop.png` | Dashboard | 1280×720 | Hero screenshot in cima al README |
| `discover-desktop.png` | Scopri | 1280×720 | Mostra i caroselli per genere |
| `calendar-desktop.png` | Calendario | 1280×720 | Mostra la settimana con airdate reali |
| `stats-desktop.png` | Statistiche | 1280×720 | Mostra card + top generi |
| `dashboard-mobile.png` | Dashboard | 390×844 | Demo del layout responsive |

Una volta generati, aggiorna `README.md` sostituendo il riferimento al placeholder SVG con gli screenshot PNG reali.

## Convenzioni

- **Niente dati personali**: usa serie TV fittizie o popolari (Breaking Bad, The Last of Us, ecc.) senza email/nome utente visibili.
- **Lingua italiana**: lascia l'UI in italiano (è il default dell'app).
- **Tema scuro**: il tema default di PloppyTV è scuro. Se in futuro aggiungiamo il tema chiaro, genera una coppia di screenshot per entrambi.
- **Niente timestamps del browser**: nascondi la barra degli indirizzi se possibile, o ritaglia via.
