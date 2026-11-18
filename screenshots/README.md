# Screenshot di PloppyTV

Screenshot reali della PWA usati nel README e nelle release notes.

## Screenshot attuali

| File | Vista | Viewport |
| --- | --- | --- |
| `dashboard.webp` | Dashboard | 1280×800 |
| `show-detail.webp` | Dettaglio serie (voti, tag, stagioni) | 1280×800 |
| `discover.webp` | Scopri, caroselli per genere | 1280×800 |
| `stats.webp` | Statistiche | 1280×800 |

Generati il 18 novembre 2026 dalla build di produzione della v1.3.1, con una libreria demo di 6 serie aggiunte dalla ricerca TVMaze. Poster, titoli e trame sono forniti da [TVMaze](https://www.tvmaze.com).

## Come rigenerarli

1. Avvia la build di produzione (non il dev server):
   ```bash
   npm run build
   npm run preview   # http://localhost:4173
   ```
2. Apri il sito in una finestra **anonima** (così non tocchi i tuoi dati) a viewport 1280×800, con la lingua dell'app in italiano.
3. Aggiungi 5-6 serie dalla ricerca con stati misti (in corso, da vedere, completata), segna qualche episodio come visto, aggiungi voti e un paio di tag.
4. Cattura ogni vista (Chrome DevTools → Cmd/Ctrl+Shift+P → "Capture screenshot").
5. Converti in WebP mantenendo il nome della vista, per esempio:
   ```bash
   magick dashboard.png -strip -quality 82 dashboard.webp
   ```
   Obiettivo: meno di 100 KB per immagine.

## Convenzioni

- **Niente dati personali**: solo serie popolari, nessun nome utente o email visibile.
- **Lingua italiana** e tema scuro (il default dell'app).
- **Niente barra del browser** né elementi esterni all'app.
