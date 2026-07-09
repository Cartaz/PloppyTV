#!/usr/bin/env bash
#
# create_commits.sh — Crea commit in sequenza per componente (stress test PloppyTV)
#
# Ogni commit raggruppa i fix di un componente logico (lib/worker/views/components/...)
# con un messaggio conventional-commits che riassume i bug principali fixati.
# I test probe_*.test.ts vengono committati insieme al sorgente del componente.
#
# Uso:
#   ./create_commits.sh [REPO_PATH]
#
#   REPO_PATH  percorso della repo PloppyTV (default: directory corrente)
#
# Lo script:
#   - verifica di essere dentro una git repo con package.json "ploppytv"
#   - per ogni componente: git add <file> && git commit -m "..."
#   - salta i commit senza modifiche da stageare (idempotente)
#   - stampa un riepilogo finale
#
# Nota: lo script NON fa push. Reviewa con `git log --oneline` e `git push` quando pronto.
#
set -euo pipefail

# --- individua la repo ---
REPO="${1:-.}"
cd "$REPO"
if [ ! -d .git ] || [ ! -f package.json ]; then
  echo "ERRORE: '$REPO' non è una repo PloppyTV (manca .git o package.json)." >&2
  exit 1
fi
if ! grep -q '"ploppytv"' package.json 2>/dev/null; then
  echo "ERRORE: package.json non sembra essere PloppyTV." >&2
  exit 1
fi

echo "Repo: $(pwd)"
echo "Branch: $(git rev-parse --abbrev-ref HEAD)"
echo "HEAD prima dei commit: $(git rev-parse --short HEAD)"
echo "========================================================"

COMMITTED=0
SKIPPED=0

# helper: stage + commit, salta se niente da committare
commit_group() {
  local msg="$1"
  shift
  # aggiungi solo file che esistono
  local files=()
  for f in "$@"; do
    [ -e "$f" ] && files+=("$f")
  done
  if [ ${#files[@]} -eq 0 ]; then
    echo "SKIP (nessun file): $msg"
    SKIPPED=$((SKIPPED + 1))
    return
  fi
  git add -- "${files[@]}"
  if git diff --cached --quiet; then
    echo "SKIP (già committato): $msg"
    SKIPPED=$((SKIPPED + 1))
    git reset --quiet -- "${files[@]}" 2>/dev/null || true
    return
  fi
  git commit -m "$msg" --quiet
  echo "OK: $msg"
  COMMITTED=$((COMMITTED + 1))
}

# ============================================================
# 1. lib/utils — edge case date/NaN/stripHtml/safeNum
# ============================================================
commit_group "fix(lib/utils): strict date validation, stripHtml quote-safe, NaN/Infinity guards

- localISODate(Date invalida) restituisce '' invece di 'NaN-NaN-NaN'
- stripHtml gestisce > dentro attributi quoted e commenti/CDATA non chiusi
- parseISODateLocal rifiuta rollover (es. 2024-02-30) validando giorni/mese
- safeNum rifiuta hex/octal/scientific notation accidentali
- findNextEpisode valida num intero positivo (no NaN/1.5/stringhe)
Test: tests/probe_a3.test.ts (70 test)" \
  src/lib/utils.ts tests/probe_a3.test.ts

# ============================================================
# 2. lib/normalize — strict validation, stripHtml, watched coercion
# ============================================================
commit_group "fix(lib/normalize): strict date validation, stripHtml su name/note/tags, watched strict

- buildShowFromTvmaze usa parseISODateLocal (no regex loose che accettava 2024-13-40)
- runtime scartato se Infinity (avvelenava totali stats)
- watched coerced strict (stringa 'false' non più contata come watched)
- stripHtml su ep.name, note, tags (defense-in-depth anti-XSS su dati importati)
- guard su episodio null/undefined nell'array
Test: tests/probe_a1.test.ts (87 test)" \
  src/lib/normalize.ts tests/probe_a1.test.ts

# ============================================================
# 3. lib/store — defensive copies, snapshot deep-clone, emit reentrancy
# ============================================================
commit_group "fix(lib/store): defensive copies, deep-clone snapshot, input validation, emit reentrancy

- setShows(null/non-array) non corrompe più state.shows
- defensive copy (.slice) su setShows/setState per evitare mutation esterne
- getStateSnapshot deep-clona tags/genres (era shallow → leak nel live state)
- guard su seasons null/array/non-object nei getter
- emitChange itera snapshot del Set (no reentrancy, no skip listener rimossi)
- subscribe rifiuta listener non-function
Test: tests/probe_a2.test.ts (47 test)" \
  src/lib/store.ts tests/probe_a2.test.ts

# ============================================================
# 4. lib/storage — CAS, corruption recovery, dedup by id, version validation
# ============================================================
commit_group "fix(lib/storage): CAS su _lastSavedAt=null, corruption recovery, dedup by id, versioni non-numeriche

- loadData non crasha se getItem lancia SecurityError (private mode Safari)
- recovery da corruzione non scrive raw corrotto nel backup
- CAS attivo anche quando _lastSavedAt=null (race multi-tab)
- storage event rigetta version non-numerica e avverte su version passata
- _dedupShowsById su loadData + storage event + backup recovery
- _validSavedAt usa Number.isFinite (NaN rompeva CAS)
Test: tests/probe_a4.test.ts (16 test)" \
  src/lib/storage.ts tests/probe_a4.test.ts

# ============================================================
# 5. lib/api — timeout/abort race, non-array response guards
# ============================================================
commit_group "fix(lib/api): race timeout/external-abort, guard su risposte non-array

- flag timedOut distingue timeout interno da abort esterno (no AbortError propagato)
- searchShows/getShowEpisodes/getShowsPage ritornano [] se risposta non-array
Test: tests/probe_a5.test.ts (33 test)" \
  src/lib/api.ts tests/probe_a5.test.ts

# ============================================================
# 6. lib/shows — preserve rating/note, guards, stripHtml name, strict airdate
# ============================================================
commit_group "fix(lib/shows): preserve rating/note on refresh, guards su seasons non-object, stripHtml name, airdate strict

- refreshShowEpisodes preserva rating e note dell'episodio esistente
- skip episodi num=0, dedup per num nella stessa stagione
- non wipa i dati se API ritorna array vuoto (glitch temporaneo)
- guard su show.seasons null/array/non-object (no crash)
- toggleEpisode/setEpisodeRating/setEpisodeNote guard su seasonArr non-array
- removeShowTag guard su tag non-stringa
- refreshShowEpisodes valida airdate con parseISODateLocal e stripHtml ep.name
- addShowToList valida list contro ALLOWED_LISTS
Test: tests/probe_a6.test.ts (80 test)" \
  src/lib/shows.ts tests/probe_a6.test.ts

# ============================================================
# 7. lib/discover — recentOnly future filter, cache validation, multi-genre
# ============================================================
commit_group "fix(lib/discover): recentOnly esclude show futuri, cache validation, weight/rating guards, multi-genre redirect

- recentOnly esclude show con premiered futuro
- cancelAnimationFrame a fine fetchAllCandidates (no callback post-resolve)
- readCache valida shape interna dei groups (no crash su cache corrotta)
- weight non-numerico/Infinity filtrato, rating.average coercito a number
- findGenreWithSpace itera tutti i generi (no redirect errato a _other)
Test: tests/probe_a7.test.ts (22 test)" \
  src/lib/discover.ts tests/probe_a7.test.ts

# ============================================================
# 8. lib/i18n + notifications + keyboard + constants
# ============================================================
commit_group "fix(lib/i18n,notifications,keyboard,constants): regex crash, lang case, notif overflow, modifier keys

i18n: t() non crasha su chiavi con metacaratteri regex, null params → '', lang case-insensitive
notifications: NOTIF_MAX_DELAY_MS sotto 2^31ms (overflow setTimeout → fire immediato), guard NaN season/ep, listener cleanup
keyboard: Ctrl/Cmd/Alt ignorati per shortcut lettera, ? inibito con modale aperta, handler cleanup
constants: normalizeApiBase rimuove trailing slash e valida protocollo
Test: tests/probe_a8.test.ts (69 test)" \
  src/lib/i18n.ts src/lib/notifications.ts src/lib/keyboard.ts src/lib/constants.ts tests/probe_a8.test.ts

# ============================================================
# 9. worker — safeShows guard, dedup genres, postMessage try/catch, fallback reject
# ============================================================
commit_group "fix(worker): safeShows filtra entry null, dedup generi, postMessage try/catch, fallback reject

- computeStats/computeCalendar non crashano su shows con entry null/non-object
- topGenres dedup generi duplicati e filtra elementi non-stringa
- client.ts postMessage in try/catch (DataCloneError) + cleanup listener/timeout
- fallback main-thread in try/catch (no promise hang infinito)
- stats.worker guard su messaggi non-object
Test: tests/probe_a9.test.ts (35 test)" \
  src/worker/compute.ts src/worker/stats.worker.ts src/worker/client.ts tests/probe_a9.test.ts

# ============================================================
# 10. views/dashboard + showList
# ============================================================
commit_group "fix(views/dashboard,showList): goldBtn binding su re-render, reset filtro tag al cambio lista, a11y, XSS ep.num

- dashboard: bottone 'Sorprendimi' rebindato ad ogni render (era inerte dopo re-render)
- dashboard: coercizione goldEp.ep.num (XSS su stato corrotto)
- showList: reset _activeTag al cambio lista (utente non più intrappolato)
- showList: chip 'Tutti' sempre visibile, bindKeydown esposto per a11y
Test: tests/probe_a10.test.ts (39 test)" \
  src/views/dashboard.ts src/views/showList.ts tests/probe_a10.test.ts

# ============================================================
# 11. views/showDetail
# ============================================================
commit_group "fix(views/showDetail): seasonAvgRating NaN/Infinity, sorting, guard non-array, modal note/tag

- seasonAvgRating filtra rating non finiti
- ordinamento episodi robusto
- guard su tags/genres/seasons non-array
- openNoteEditor/openAddTagModal guard su input
- addTag modal keepOpen on failure
- guard show.image non-stringa
Test: tests/probe_a11.test.ts (XSS regression + P2 interactions)" \
  src/views/showDetail.ts tests/probe_a11.test.ts

# ============================================================
# 12. views/discover + library
# ============================================================
commit_group "fix(views/discover,library): XSS in modal body, data-show-id escape, filter guards

- discover: escape rating.average e runtime nel modal body (XSS)
- discover: data-show-id escapato (attribute breakout)
- discover: rating.average=0 mostrato correttamente (non 'N/D')
- library: guard su tag/name non-stringa in applyFilters
- library: dropdown nascosto solo se nessun filtro attivo (no stale filter)
Test: tests/probe_a12.test.ts" \
  src/views/discover.ts src/views/library.ts tests/probe_a12.test.ts

# ============================================================
# 13. views/calendar + stats
# ============================================================
commit_group "fix(views/calendar,stats): cross-view race protection, XSS, NaN edge

- cross-view race: risultato worker stale non applicato dopo cambio vista
- XSS su showName/genere
- edge case NaN su 0 serie / 0 episodi
Test: tests/probe_a13.test.ts" \
  src/views/calendar.ts src/views/stats.ts tests/probe_a13.test.ts

# ============================================================
# 14. views/yearReview
# ============================================================
commit_group "fix(views/yearReview): watched strict, airdate/runtime guards, toBlob try/catch, blob URL leak

- ep.watched strict === true (no truthy 'false')
- airdate typeof string guard, runtime Number.isFinite (no concatenazione stringhe)
- guard seasons null/array
- canvas.toBlob in try/catch (SecurityError su tainted canvas)
- URL.revokeObjectURL in try/finally (no leak)
- toBlob availability check, filename fallback se year NaN
- validazione anno button click
Test: tests/probe_a14.test.ts (81 test)" \
  src/views/yearReview.ts tests/probe_a14.test.ts

# ============================================================
# 15. components/modal + toast
# ============================================================
commit_group "fix(components/modal,toast): init idempotente, reentrancy onClick, focus trap completo, dismiss API

- modal: guard _modalInitialized (no listener duplicati su re-init/HMR)
- modal: onClick check identity-based (no double-pop su swap)
- modal: focus trap include textarea/select/summary + wrap quando active non focusable
- modal: pulizia body/actions su stack vuoto, aria-labelledby condizionale
- toast: dismissToast() export, showToast(null/undefined) → ''
Test: tests/probe_a15.test.ts (49 test)" \
  src/components/modal.ts src/components/toast.ts tests/probe_a15.test.ts

# ============================================================
# 16. components/search + exportImport
# ============================================================
commit_group "fix(components/search,exportImport): select clear race, onload try/catch, listener leak

- search: selectSearchResult non cancella input se utente ha digitato durante await
- search: try/catch su addShowToList (no unhandled rejection)
- search: document click listener non accumula su re-init
- exportImport: reader.onload post-parse in try/catch (no crash silente)
Test: tests/probe_a16.test.ts" \
  src/components/search.ts src/components/exportImport.ts tests/probe_a16.test.ts

# ============================================================
# 17. components/img + imageFallback + renderer + header
# ============================================================
commit_group "fix(components/img,imageFallback,renderer,header): scheme validation, loop infinito, init idempotente, scroll lock

- img: imgTag valida src con safeImageUrl (rifiuta javascript:/data:)
- img: escape cls/extraStyle in tutti gli attributi (no XSS via style)
- imageFallback: flag data-fallback-src-tried (no loop infinito con fallback relativo)
- imageFallback: destroyImageFallback per cleanup
- renderer: getMain ritorna null (no crash), safeId per data-show-id, safeImport data-action (CSP-safe), salta bind se showDetail baila
- header: initHeader idempotency guard, updateBadges guard non-array, sidebar scroll lock + ESC, delegated [data-lang]
Test: tests/probe_a17.test.ts" \
  src/components/img.ts src/components/imageFallback.ts src/components/renderer.ts src/components/header.ts tests/probe_a17.test.ts

# ============================================================
# 18. main + sw + index.html
# ============================================================
commit_group "fix(main,sw,index.html): init order, SW update flow, hash routing, SKIP_WAITING message

- main: init order robusto, error handling, hash routing iniziale
- main: SW registration + update toast + controllerchange
- sw: SKIP_WAITING message format end-to-end, precache fallback offline
- index.html: meta/manifest/preconnect/lang
Test: tests/probe_a18.test.ts" \
  src/main.ts src/sw.ts index.html tests/probe_a18.test.ts

# ============================================================
# 19. test: edge cases cross-cutting (A19 + A20)
# ============================================================
commit_group "test(edge-cases): stress test cross-cutting storage/shows/XSS/NaN end-to-end

- A19: storage quota, dati corrotti, import enormi, multi-tab CAS, date invalide, combinazioni
- A20: XSS via summary/note/tag/attributi, NaN/Infinity rating/runtime, season 0, type confusion
- Verifica end-to-end: NESSUN tag script/event handler sopravvive nel DOM dopo il render
Test: tests/probe_a19.test.ts + tests/probe_a20.test.ts (70 test)" \
  tests/probe_a19.test.ts tests/probe_a20.test.ts

# ============================================================
# 20. chore: package-lock
# ============================================================
commit_group "chore: aggiorna package-lock.json (npm install)" \
  package-lock.json

# ============================================================
echo "========================================================"
echo "Riepilogo: $COMMITTED commit creati, $SKIPPED saltati"
echo "HEAD dopo i commit: $(git rev-parse --short HEAD)"
echo "Verifica: git log --oneline -20"
