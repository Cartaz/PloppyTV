from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    src = p.read_text()
    if src.count(old) != 1:
        raise SystemExit(f"{path}: expected anchor exactly once: {old[:80]!r}")
    p.write_text(src.replace(old, new, 1))


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    p = Path(path)
    src = p.read_text()
    start_idx = src.find(start)
    end_idx = src.find(end, start_idx + len(start)) if start_idx >= 0 else -1
    if start_idx < 0 or end_idx < 0:
        raise SystemExit(f"{path}: range anchors not found: {start!r} -> {end!r}")
    p.write_text(src[:start_idx] + replacement + src[end_idx:])


# main.ts: startup must not contact TVMaze merely to speculate about a future Discover visit.
replace_once("src/main.ts", "import { preloadDiscover } from './lib/discover';\n", "")
replace_between(
    "src/main.ts",
    "    // Preload in background dei dati Discover (serie popolari + recenti).\n",
    "    // BUG-A18-02: beforeunload registrato DENTRO init() DOPO loadData.\n",
    "",
)

# discover.ts: retain only on-demand request sharing; remove the preload concept entirely.
replace_between(
    "src/lib/discover.ts",
    "// Promise condivise per il preload in background: una volta avviate, le viste\n",
    "export function invalidateDiscoverCache(tab: 'popular' | 'recent'): void {\n",
    """// Richieste condivise per tab: due render concorrenti si agganciano allo stesso
// caricamento on-demand senza duplicare le chiamate TVMaze.
let _popularRequest: Promise<DiscoverGroups> | null = null;
let _recentRequest: Promise<DiscoverGroups> | null = null;

/**
 * Carica i dati del tab richiesto solo quando la vista Discover ne ha bisogno.
 * Una richiesta in corso viene condivisa; se fallisce, il riferimento viene
 * azzerato così un successivo retry può davvero effettuare una nuova richiesta.
 */
export function loadDiscover(tab: 'popular' | 'recent'): Promise<DiscoverGroups> {
  if (tab === 'popular') {
    if (!_popularRequest) {
      _popularRequest = getPopularShows().catch((error) => {
        _popularRequest = null;
        throw error;
      });
    }
    return _popularRequest;
  }

  if (!_recentRequest) {
    _recentRequest = getRecentShows().catch((error) => {
      _recentRequest = null;
      throw error;
    });
  }
  return _recentRequest;
}

/**
 * Dimentica la richiesta condivisa del tab indicato. Usato da "Aggiorna lista"
 * dopo l'invalidazione della cache locale, così il prossimo load è fresco.
 */
export function resetDiscoverLoad(tab?: 'popular' | 'recent'): void {
  if (!tab || tab === 'popular') _popularRequest = null;
  if (!tab || tab === 'recent') _recentRequest = null;
}

""",
)

# View API names now describe semantics rather than Promise/preload implementation details.
view = Path("src/views/discover.ts")
view_src = view.read_text()
for old, new in [
    ("resetDiscoverPreload", "resetDiscoverLoad"),
    ("getDiscoverPromise", "loadDiscover"),
]:
    if old not in view_src:
        raise SystemExit(f"src/views/discover.ts: missing {old}")
    view_src = view_src.replace(old, new)
view.write_text(view_src)

# Privacy/documentation: external requests from Discover become explicitly user-driven.
replace_once(
    "PRIVACY.md",
    "**Ultimo aggiornamento:** 30 agosto 2026",
    "**Ultimo aggiornamento:** 31 agosto 2026",
)
replace_once(
    "PRIVACY.md",
    "- I metadati delle serie arrivano da **TVMaze**. La sezione Scopri può effettuare un preload poco dopo l'avvio per ridurre il tempo di attesa quando la apri.",
    "- I metadati delle serie arrivano da **TVMaze**. La sezione Scopri contatta TVMaze solo quando la apri o chiedi esplicitamente di aggiornarla.",
)
replace_once(
    "PRIVACY.md",
    "- **Scopri** → circa 1,5 secondi dopo l'avvio, se lo storage locale è disponibile, PloppyTV può avviare in background il caricamento degli elenchi popolari/recenti. Questo preload è intenzionale per rendere la pagina Scopri più rapida; può quindi contattare TVMaze anche se non hai ancora aperto quella vista.",
    "- **Scopri** → quando apri la vista, PloppyTV carica il tab richiesto (popolari o recenti); ulteriori richieste avvengono quando cambi tab o usi \"Aggiorna lista\" se i dati non sono già disponibili in cache.",
)
replace_once(
    "README.md",
    "- **Scopri**: serie popolari e recenti raggruppate per genere, con preload in background",
    "- **Scopri**: serie popolari e recenti raggruppate per genere, caricate on demand con cache locale",
)
replace_once(
    "README.md",
    "- Scopri effettua intenzionalmente un preload in background poco dopo l'avvio per ridurre la latenza della prima apertura",
    "- Scopri contatta TVMaze solo quando apri la vista o richiedi esplicitamente un aggiornamento",
)

# main probe: remove tests/mocks for behavior deliberately deleted from startup.
replace_once(
    "tests/probe_main.test.ts",
    "// Stress test: init order, hash routing, SW registration + onNeedRefresh,\n// beforeunload, preloadDiscover, standalone detection, double-init.\n",
    "// Stress test: init order, hash routing, SW registration + onNeedRefresh,\n// beforeunload, standalone detection, double-init.\n",
)
replace_once("tests/probe_main.test.ts", "const mockPreloadDiscover = vi.fn();\n", "")
replace_once(
    "tests/probe_main.test.ts",
    """vi.mock('../src/lib/discover', () => ({
  preloadDiscover: () => mockPreloadDiscover(),
}));

""",
    "",
)
replace_once("tests/probe_main.test.ts", "  mockPreloadDiscover.mockReset();\n", "")
replace_once("tests/probe_main.test.ts", "    expect(mockPreloadDiscover).not.toHaveBeenCalled();\n", "")
replace_between(
    "tests/probe_main.test.ts",
    "describe('main.ts — preloadDiscover', () => {\n",
    "describe('main.ts — standalone detection', () => {\n",
    "",
)

# A18 code-reading now protects the privacy/network invariant instead of the removed timer.
replace_once(
    "tests/probe_a18.test.ts",
    """  it('preloadDiscover wrapped in try/catch inside setTimeout', () => {
    const idx = mainSrc.indexOf('preloadDiscover()');
    const block = mainSrc.slice(idx - 100, idx + 100);
    expect(block).toMatch(/\\btry\\s*\\{/);
    expect(block).toMatch(/catch\\s*\\(/);
  });
""",
    """  it('startup does not preload Discover or import its network module', () => {
    expect(mainSrc).not.toContain('preloadDiscover');
    expect(mainSrc).not.toContain("from './lib/discover'");
  });
""",
)

# Discover library tests: rename the reset API and add direct contract tests for on-demand sharing.
probe_discover = Path("tests/probe_discover.test.ts")
pd_src = probe_discover.read_text()
if "resetDiscoverPreload" not in pd_src:
    raise SystemExit("tests/probe_discover.test.ts: resetDiscoverPreload not found")
pd_src = pd_src.replace("resetDiscoverPreload", "resetDiscoverLoad")
pd_src = pd_src.replace(
    "  getRecentShows,\n  resetDiscoverLoad,\n",
    "  getRecentShows,\n  loadDiscover,\n  resetDiscoverLoad,\n",
    1,
)
insert_anchor = "  it('FASE2 respects DISCOVER_TARGET_PER_GENRE cap (BUG-07-01 fixed)', async () => {\n"
if pd_src.count(insert_anchor) != 1:
    raise SystemExit("tests/probe_discover.test.ts: insertion anchor missing")
pd_src = pd_src.replace(
    insert_anchor,
    """  it('loadDiscover deduplicates concurrent requests for the same tab', async () => {
    mockedGetShowsPage.mockImplementation(async (page: number) => [makeShow(page * 1000 + 1)]);

    const first = loadDiscover('popular');
    const second = loadDiscover('popular');

    expect(second).toBe(first);
    await first;
    expect(mockedGetShowsPage).toHaveBeenCalledTimes(DISCOVER_POPULAR_PAGES.length);
  });

  it('resetDiscoverLoad makes the next load a fresh request', async () => {
    mockedGetShowsPage.mockImplementation(async (page: number) => [makeShow(page * 1000 + 1)]);

    const first = loadDiscover('popular');
    await first;
    const callsAfterFirstLoad = mockedGetShowsPage.mock.calls.length;

    invalidateDiscoverCache('popular');
    resetDiscoverLoad('popular');
    const second = loadDiscover('popular');

    expect(second).not.toBe(first);
    await second;
    expect(mockedGetShowsPage.mock.calls.length).toBe(callsAfterFirstLoad + DISCOVER_POPULAR_PAGES.length);
  });

""" + insert_anchor,
    1,
)
probe_discover.write_text(pd_src)

# Discover view mocks follow the semantic API rename.
probe_view = Path("tests/probe_discoverview.test.ts")
pv_src = probe_view.read_text()
for old, new in [
    ("mockGetDiscoverPromise", "mockLoadDiscover"),
    ("getDiscoverPromise", "loadDiscover"),
    ("mockResetDiscoverPreload", "mockResetDiscoverLoad"),
    ("resetDiscoverPreload", "resetDiscoverLoad"),
]:
    if old not in pv_src:
        raise SystemExit(f"tests/probe_discoverview.test.ts: missing {old}")
    pv_src = pv_src.replace(old, new)
probe_view.write_text(pv_src)
