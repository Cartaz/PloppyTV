// Agent 17 probe: src/views/stats.ts (renderStats / renderStatsContent)
//
// renderStatsContent is module-private (not exported), so we exercise it through
// the public `renderStats(main)` async wrapper. We mock '../src/worker/client'
// so that `computeStatsAsync` returns crafted StatsResult objects, letting us
// probe edge cases the worker would never actually emit (e.g. totalProgress=140
// or pct=-20) — i.e. defense-in-depth verification of the view's own clamps.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StatsResult } from '../src/types';

// --- Mocks (vitest-hoisted) ---

vi.mock('../src/worker/client', () => ({
  computeStatsAsync: vi.fn(),
}));

vi.mock('../src/lib/store', () => ({
  getState: () => ({ shows: [] as unknown[] }),
}));

import { renderStats } from '../src/views/stats';
import { computeStatsAsync } from '../src/worker/client';

const mockCompute = vi.mocked(computeStatsAsync);

// --- Helpers ---

function makeMain(): HTMLElement {
  const el = document.createElement('main');
  document.body.innerHTML = '';
  document.body.appendChild(el);
  return el;
}

function makeStats(over: Partial<StatsResult> = {}): StatsResult {
  return {
    totalShows: 1,
    totalWatched: 0,
    totalEpisodes: 0,
    completedShows: 0,
    watchingShows: 0,
    towatchShows: 1,
    totalMinutes: 0,
    totalDays: 0,
    remHours: 0,
    timeLabel: '0min',
    totalProgress: 0,
    topGenres: [],
    topShows: [],
    ...over,
  };
}

function statValues(main: HTMLElement): string[] {
  return Array.from(main.querySelectorAll<HTMLElement>('.stat-card .stat-value')).map(
    (el) => el.textContent ?? '',
  );
}

function statLabels(main: HTMLElement): string[] {
  return Array.from(main.querySelectorAll<HTMLElement>('.stat-card .stat-label')).map(
    (el) => el.textContent ?? '',
  );
}

// Sections in renderStatsContent (when totalShows>0):
//   [0] = totalProgress bar section
//   [1] = Generi section
//   [2] = Top serie section
function generiSection(main: HTMLElement): HTMLElement {
  return main.querySelectorAll<HTMLElement>('.section')[1];
}
function topShowsSection(main: HTMLElement): HTMLElement {
  return main.querySelectorAll<HTMLElement>('.section')[2];
}
function generiBars(main: HTMLElement): HTMLElement[] {
  // Each genre bar is the inner div of `<div style="height:8px;...">`.
  return Array.from(
    generiSection(main).querySelectorAll<HTMLDivElement>('div[style*="height:8px"] > div'),
  );
}
function progressBar(main: HTMLElement): HTMLElement {
  return main.querySelector('.section > div > div') as HTMLElement;
}

beforeEach(() => {
  mockCompute.mockReset();
});

// ============================================================
// 1) Empty state
// ============================================================

describe('[stats view] empty state (totalShows=0)', () => {
  it('renders "Nessun dato" empty state, no cards/sections', async () => {
    mockCompute.mockResolvedValue(makeStats({ totalShows: 0 }));
    const main = makeMain();
    await renderStats(main);
    expect(main.innerHTML).toContain('Statistiche');
    expect(main.querySelector('.empty-state-title')?.textContent).toBe('Nessun dato');
    expect(main.querySelector('.stats-grid')).toBeNull();
    expect(main.querySelector('.section')).toBeNull();
  });

  it('does NOT render stat cards even if other fields are non-zero', async () => {
    // Defensive: view must trust totalShows as the gate, not other counts.
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 0,
        totalWatched: 999,
        totalProgress: 50,
        topGenres: [{ genre: 'Drama', episodes: 10, shows: 2 }],
        topShows: [
          { showId: 1, showName: 'X', image: null, watched: 5, totalEpisodes: 10, pct: 50 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    expect(main.querySelector('.stats-grid')).toBeNull();
    expect(main.querySelector('.section')).toBeNull();
  });
});

// ============================================================
// 2) Stat cards — values + labels
// ============================================================

describe('[stats view] stat cards', () => {
  it('renders 7 cards with correct labels', async () => {
    mockCompute.mockResolvedValue(makeStats({ totalShows: 5 }));
    const main = makeMain();
    await renderStats(main);
    expect(statLabels(main)).toEqual([
      'Serie tracciate',
      'Episodi visti',
      'Tempo totale',
      'Completate',
      'In corso',
      'Da vedere',
      'Progresso totale',
    ]);
  });

  it('renders numeric stat values verbatim', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 7,
        totalWatched: 42,
        timeLabel: '2g 3h',
        completedShows: 2,
        watchingShows: 3,
        towatchShows: 2,
        totalProgress: 60,
      }),
    );
    const main = makeMain();
    await renderStats(main);
    expect(statValues(main)).toEqual(['7', '42', '2g 3h', '2', '3', '2', '60%']);
  });

  it('escapeHtml-applies timeLabel (special chars are escaped)', async () => {
    mockCompute.mockResolvedValue(makeStats({ totalShows: 1, timeLabel: '<b>x</b>&"y"' }));
    const main = makeMain();
    await renderStats(main);
    const valEl = main.querySelectorAll('.stat-card .stat-value')[2];
    // textContent preserves the original string (no DOM mutation)
    expect(valEl.textContent).toBe('<b>x</b>&"y"');
    // But no <b> element was actually created → escapeHtml worked.
    expect(valEl.querySelector('b')).toBeNull();
    // The serialized HTML source escapes `<`, `>`, `&` (jsdom leaves `"` as-is
    // because it doesn't need escaping in text content).
    expect(valEl.innerHTML).toContain('&lt;b&gt;');
    expect(valEl.innerHTML).toContain('&amp;');
  });

  it('does NOT escape numeric cards — crafted string value would inject HTML (defense-in-depth gap)', async () => {
    // Worker always emits numbers; this test pins the (lack of) defensive behavior.
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: '<img src=x onerror=alert(1)>' as unknown as number,
      }),
    );
    const main = makeMain();
    await renderStats(main);
    // BUG (Low, defense-in-depth): value is interpolated raw → live <img> in DOM
    // jsdom re-serializes with quoted attrs; we check by querying for the element.
    const injected = main.querySelector('.stat-card img');
    expect(injected).not.toBeNull();
    expect(injected?.getAttribute('src')).toBe('x');
    expect(injected?.getAttribute('onerror')).toBe('alert(1)');
  });
});

// ============================================================
// 3) totalProgress clamp + bar color
// ============================================================

describe('[stats view] totalProgress clamp', () => {
  it('clamps >100 to 100, green bar, 100% label', async () => {
    mockCompute.mockResolvedValue(makeStats({ totalShows: 1, totalProgress: 140 }));
    const main = makeMain();
    await renderStats(main);
    const card = main.querySelectorAll('.stat-card .stat-value')[6];
    expect(card.textContent).toBe('100%');
    const bar = progressBar(main);
    expect(bar.getAttribute('style') ?? '').toContain('width:100%');
    expect(bar.getAttribute('style') ?? '').toContain('var(--success');
  });

  it('clamps negative to 0, accent color, 0% label', async () => {
    mockCompute.mockResolvedValue(makeStats({ totalShows: 1, totalProgress: -50 }));
    const main = makeMain();
    await renderStats(main);
    const card = main.querySelectorAll('.stat-card .stat-value')[6];
    expect(card.textContent).toBe('0%');
    const bar = progressBar(main);
    expect(bar.getAttribute('style') ?? '').toContain('width:0%');
    expect(bar.getAttribute('style') ?? '').toContain('var(--accent)');
  });

  it('exactly 100 → green', async () => {
    mockCompute.mockResolvedValue(makeStats({ totalShows: 1, totalProgress: 100 }));
    const main = makeMain();
    await renderStats(main);
    const bar = progressBar(main);
    expect(bar.getAttribute('style') ?? '').toContain('var(--success');
  });

  it('99 → accent (not complete)', async () => {
    mockCompute.mockResolvedValue(makeStats({ totalShows: 1, totalProgress: 99 }));
    const main = makeMain();
    await renderStats(main);
    const bar = progressBar(main);
    expect(bar.getAttribute('style') ?? '').toContain('var(--accent)');
  });

  it('fractional totalProgress is NOT rounded by view (worker emits integer)', async () => {
    // View clamp uses Math.max/Math.min only — no round. Worker rounds, but
    // if a crafted StatsResult slips through with 50.7, the bar would be
    // "width:50.7%" (valid CSS) and label "50.7%". Pin this behavior.
    mockCompute.mockResolvedValue(makeStats({ totalShows: 1, totalProgress: 50.7 }));
    const main = makeMain();
    await renderStats(main);
    const card = main.querySelectorAll('.stat-card .stat-value')[6];
    expect(card.textContent).toBe('50.7%');
  });
});

// ============================================================
// 4) topGenres — maxCount, pct, "Nessun dato"
// ============================================================

describe('[stats view] topGenres', () => {
  it('topGenres empty → "Nessun dato" message', async () => {
    mockCompute.mockResolvedValue(makeStats({ totalShows: 1, topGenres: [] }));
    const main = makeMain();
    await renderStats(main);
    const sections = main.querySelectorAll('.section');
    // [0]=progress bar, [1]=generi, [2]=top shows
    expect(sections.length).toBe(3);
    expect(generiSection(main).textContent).toContain('Nessun dato');
  });

  it('topGenres all zero episodes → "Nessun dato" (every() check)', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 2,
        topGenres: [
          { genre: 'Drama', episodes: 0, shows: 1 },
          { genre: 'Comedy', episodes: 0, shows: 1 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    expect(generiSection(main).textContent).toContain('Nessun dato');
    expect(generiBars(main)).toHaveLength(0);
  });

  it('renders bars with correct relative pct (first = 100%)', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topGenres: [
          { genre: 'Drama', episodes: 10, shows: 3 },
          { genre: 'Comedy', episodes: 5, shows: 2 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const bars = generiBars(main);
    // Two bars; Drama=100%, Comedy=50%
    expect(bars.length).toBe(2);
    expect(bars[0].getAttribute('style') ?? '').toContain('width:100%');
    expect(bars[1].getAttribute('style') ?? '').toContain('width:50%');
  });

  it('pct IS rounded — BUG-17-04 fixed (no fractional widths in CSS)', async () => {
    // 2/3 episodes → 66.66666666666666% pre-round, rounded to 67%
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topGenres: [
          { genre: 'A', episodes: 3, shows: 1 },
          { genre: 'B', episodes: 2, shows: 1 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const bars = generiBars(main);
    // After BUG-17-04 fix: Math.round → 67% (not 66.66666666666666%)
    expect(bars[1].getAttribute('style') ?? '').toContain('width:67%');
    expect(bars[1].getAttribute('style') ?? '').not.toContain('66.66666666666666');
  });

  it('escapes genre names (XSS defense)', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topGenres: [{ genre: '<script>alert(1)</script>', episodes: 1, shows: 1 }],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const sectionHtml = generiSection(main).innerHTML;
    expect(sectionHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(sectionHtml).not.toContain('<script>');
  });

  it('renders genre count line "N ep • M serie"', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topGenres: [{ genre: 'Drama', episodes: 10, shows: 3 }],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const txt = generiSection(main).textContent ?? '';
    expect(txt).toContain('10 ep • 3 serie');
  });

  it('BUG-17-05 fix: bar pct clamped to [0, 100] even when sort invariant is violated (maxCount `|| 1` fallback)', async () => {
    // The worker sorts desc by episodes, so topGenres[0].episodes=0 means all are 0.
    // But if a crafted StatsResult violates that invariant, maxCount becomes 1
    // (via `0 || 1`), and other genres would get inflated pct (>100%) — but now
    // the view clamps to 100.
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topGenres: [
          { genre: 'A', episodes: 0, shows: 1 },
          { genre: 'B', episodes: 5, shows: 1 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    // every() check is false (B has 5), so bars render.
    const bars = generiBars(main);
    expect(bars.length).toBe(2);
    // After BUG-17-05 fix: maxCount = 0 || 1 = 1 → A: 0/1*100=0%, B: 5/1*100=500%
    // but clamped to 100 → bar B is width:100% (not 500%).
    expect(bars[1].getAttribute('style') ?? '').toContain('width:100%');
    expect(bars[1].getAttribute('style') ?? '').not.toContain('width:500%');
  });
});

// ============================================================
// 5) topShows — clamp, escape, data-action, image
// ============================================================

describe('[stats view] topShows', () => {
  it('topShows empty → "Nessun dato."', async () => {
    mockCompute.mockResolvedValue(makeStats({ totalShows: 1, topShows: [] }));
    const main = makeMain();
    await renderStats(main);
    expect(topShowsSection(main).textContent).toContain('Nessun dato');
  });

  it('renders top show with data-action="openShow" + data-show-id', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topShows: [
          { showId: 42, showName: 'Test', image: null, watched: 5, totalEpisodes: 10, pct: 50 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const item = main.querySelector('.episode-item') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.dataset.action).toBe('openShow');
    expect(item.dataset.showId).toBe('42');
    expect(item.getAttribute('style') ?? '').toContain('cursor:pointer');
  });

  it('displays "watched/totalEp episodi • pct%"', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topShows: [
          { showId: 1, showName: 'A', image: null, watched: 7, totalEpisodes: 10, pct: 70 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toBe('7/10 episodi • 70%');
  });

  it('clamps pct >100 to 100 (defense-in-depth)', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topShows: [
          { showId: 1, showName: 'A', image: null, watched: 20, totalEpisodes: 10, pct: 200 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toBe('20/10 episodi • 100%');
  });

  it('clamps negative pct to 0', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topShows: [
          { showId: 1, showName: 'A', image: null, watched: 0, totalEpisodes: 10, pct: -20 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toBe('0/10 episodi • 0%');
  });

  it('rounds pct with Math.round (50.5 → 51)', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topShows: [
          { showId: 1, showName: 'A', image: null, watched: 101, totalEpisodes: 200, pct: 50.5 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toBe('101/200 episodi • 51%');
  });

  it('escapes showName', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topShows: [
          { showId: 1, showName: '<b>X</b>', image: null, watched: 1, totalEpisodes: 1, pct: 100 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const nameEl = main.querySelector('.episode-name') as HTMLElement;
    expect(nameEl.innerHTML).toBe('&lt;b&gt;X&lt;/b&gt;');
  });

  it('image=null → no <img>/<div> rendered, just episode-info', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topShows: [
          { showId: 1, showName: 'A', image: null, watched: 1, totalEpisodes: 1, pct: 100 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const item = main.querySelector('.episode-item') as HTMLElement;
    expect(item.querySelector('img')).toBeNull();
    expect(item.querySelector('div[class*="placeholder"]')).toBeNull();
    expect(item.querySelector('.episode-info')).not.toBeNull();
  });

  it('BUG-17-01 fix: image truthy → imgTag <img> DOES get extraStyle (poster constrained to 40×60)', async () => {
    // After BUG-17-01 fix, imgTag applies extraStyle to BOTH the <img> (inline
    // style) AND stores it in data-fallback-style for the error placeholder.
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: 'A',
            image: 'https://example.com/p.jpg',
            watched: 1,
            totalEpisodes: 1,
            pct: 100,
          },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const img = main.querySelector('.episode-item img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.com/p.jpg');
    // Fixed: <img> now has the inline style (width:40px;height:60px;…).
    const style = img?.getAttribute('style') ?? '';
    expect(style).toContain('width:40px');
    expect(style).toContain('height:60px');
    expect(style).toContain('object-fit:cover');
    expect(style).toContain('border-radius:4px');
    // The fallback data-attribute is still present (for the error placeholder).
    expect(img?.getAttribute('data-fallback-style') ?? '').toContain('width:40px');
    expect(img?.getAttribute('data-fallback-style') ?? '').toContain('height:60px');
  });

  it('topShows totalEpisodes=0 with watched>0 → displays "5/0 episodi • 0%" (inconsistent state)', async () => {
    mockCompute.mockResolvedValue(
      makeStats({
        totalShows: 1,
        topShows: [
          { showId: 1, showName: 'A', image: null, watched: 5, totalEpisodes: 0, pct: 0 },
        ],
      }),
    );
    const main = makeMain();
    await renderStats(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toBe('5/0 episodi • 0%');
  });

  it('renders all topShows items (no cap issue; worker already sliced to 10)', async () => {
    const topShows = Array.from({ length: 12 }, (_, i) => ({
      showId: i + 1,
      showName: 'S' + i,
      image: null,
      watched: i,
      totalEpisodes: 12,
      pct: (i / 12) * 100,
    }));
    mockCompute.mockResolvedValue(makeStats({ totalShows: 12, topShows }));
    const main = makeMain();
    await renderStats(main);
    // View renders ALL items it receives; it does NOT slice.
    expect(main.querySelectorAll('.episode-item').length).toBe(12);
  });
});

// ============================================================
// 6) Skeleton + error path
// ============================================================

describe('[stats view] skeleton + error', () => {
  it('renders skeleton before computeStatsAsync resolves', async () => {
    let resolveLater!: (v: StatsResult) => void;
    mockCompute.mockReturnValue(
      new Promise<StatsResult>((res) => {
        resolveLater = res;
      }),
    );
    const main = makeMain();
    const p = renderStats(main);
    // Synchronously after calling renderStats, skeleton should be in DOM.
    expect(main.innerHTML).toContain('Calcolando statistiche');
    expect(main.querySelector('.loading')).not.toBeNull();
    resolveLater(makeStats({ totalShows: 1 }));
    await p;
    // After resolve, real content replaces skeleton.
    expect(main.querySelector('.loading')).toBeNull();
    expect(main.querySelector('.stats-grid')).not.toBeNull();
  });

  it('computeStatsAsync rejects → error fallback UI', async () => {
    mockCompute.mockRejectedValue(new Error('boom'));
    const main = makeMain();
    await renderStats(main);
    expect(main.querySelector('.empty-state-title')?.textContent).toBe('Errore caricamento');
    expect(main.querySelector('.stats-grid')).toBeNull();
  });
});

// ============================================================
// 7) Stale-render race (concurrency)
// ============================================================

describe('[stats view] stale-render race (BUG-17-02 invalidation token fix)', () => {
  it('BUG-17-02 fix: a second renderStats call invalidates the first — late resolve is a no-op', async () => {
    // The invalidation token (`_statsRenderToken`) is a module-level counter
    // incremented at the START of each renderStats call. After `await`, the
    // call checks if its captured token is still current; if not, it returns
    // without touching main. This test drives the second-call scenario
    // directly: call renderStats twice, never resolve the first, resolve the
    // second, then resolve the first — the first resolution must be a no-op.
    let resolveFirst!: (v: StatsResult) => void;
    let resolveSecond!: (v: StatsResult) => void;
    mockCompute.mockReturnValueOnce(
      new Promise<StatsResult>((res) => {
        resolveFirst = res;
      }),
    );
    mockCompute.mockReturnValueOnce(
      new Promise<StatsResult>((res) => {
        resolveSecond = res;
      }),
    );

    const main = makeMain();
    // First call — its resolution will be slow.
    const firstPromise = renderStats(main);
    expect(main.querySelector('.loading')).not.toBeNull();

    // Second call — supersedes the first via the token (counter goes 1→2).
    const secondPromise = renderStats(main);

    // The second compute resolves first; renders the stats content.
    resolveSecond(
      makeStats({
        totalShows: 5,
        totalWatched: 10,
        topGenres: [{ genre: 'Drama', episodes: 10, shows: 3 }],
        topShows: [
          { showId: 1, showName: 'A', image: null, watched: 5, totalEpisodes: 10, pct: 50 },
        ],
      }),
    );
    await secondPromise;
    expect(main.querySelector('.stats-grid')).not.toBeNull();

    // Now the first compute resolves late. After BUG-17-02 fix, this is a
    // no-op (the first call's token was 1, current is 2 — mismatch → return).
    // Capture the DOM state to compare.
    const htmlBefore = main.innerHTML;
    resolveFirst(makeStats({ totalShows: 999, totalWatched: 999 }));
    await firstPromise;
    // DOM is unchanged — the late first resolution did not overwrite.
    expect(main.innerHTML).toBe(htmlBefore);
    // The "999" stats values are NOT injected.
    expect(main.innerHTML).not.toContain('999');
  });

  it('does not crash if computeStatsAsync resolves after main was detached from DOM', async () => {
    let resolveStats!: (v: StatsResult) => void;
    mockCompute.mockReturnValue(
      new Promise<StatsResult>((res) => {
        resolveStats = res;
      }),
    );
    const main = makeMain();
    const p = renderStats(main);
    // Detach main from DOM (simulating aggressive view swap that removes element).
    main.remove();
    resolveStats(makeStats({ totalShows: 5 }));
    // Should not throw.
    await expect(p).resolves.toBeUndefined();
  });
});
