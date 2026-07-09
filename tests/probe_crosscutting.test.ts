// Agent 20 — cross-cutting audit probe.
// Covers: XSS/injection across views, accessibility (keyboard focusability
// of clickable divs), type-safety hazards (Number() coercion), cross-module
// consistency (progress clamp, safeImageUrl scope, reconciler divergence).
//
// Strategy: import real views + store; populate state with malicious show
// data; render; assert the resulting innerHTML does NOT contain raw
// unescaped injection.  Then query rendered DOM to verify clickable divs
// lack keyboard accessibility attributes.
//
// DOM setup: we set up the full app shell (main + modal + toast) ONCE in
// beforeAll and only reset mainContent's innerHTML in beforeEach. This
// avoids invalidating the modal module's cached DOM refs (which would
// happen if we replaced document.body.innerHTML each test).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Show, TvmazeShow } from '../src/types';
import { setShows, setState, getState } from '../src/lib/store';
import { initModal, closeAllModals, showModal } from '../src/components/modal';

// ---------- helpers ----------

function maliciousShow(over: Partial<Show> = {}): Show {
  return {
    id: 1,
    name: '<img src=x onerror=alert(1)>',
    image: null,
    status: '<script>alert("status")</script>',
    premiered: '2024-01-01',
    genres: ['<b>Drama</b>', 'Comedy'],
    summary: '<script>evil()</script>plain text',
    network: '<a href="javascript:alert(1)">net</a>',
    runtime: 45,
    list: 'watching',
    manualList: false,
    seasons: {
      1: [
        {
          num: 1,
          id: 11,
          watched: false,
          airdate: '2024-01-01',
          name: '<img src=y onerror=alert(2)>',
          runtime: 45,
        },
        {
          num: 2,
          id: 12,
          watched: true,
          airdate: null,
          name: null,
          runtime: null,
        },
      ],
    },
    totalSeasons: 1,
    totalEpisodes: 2,
    addedAt: 1700000000000,
    ...over,
  };
}

const APP_SHELL = `
  <main class="main" id="mainContent"></main>
  <div class="modal-overlay" id="modal" role="dialog" aria-modal="true" aria-hidden="true">
    <div class="modal" tabindex="-1">
      <div class="modal-title" id="modalTitle"></div>
      <div class="modal-body" id="modalBody"></div>
      <div class="modal-actions" id="modalActions"></div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
`;

// ---------- setup ----------

beforeAll(() => {
  document.body.innerHTML = APP_SHELL;
  initModal();
});

beforeEach(() => {
  // Reset only mainContent; preserve modal + toast shell.
  document.getElementById('mainContent')!.innerHTML = '';
  closeAllModals();
  setShows([]);
  setState({
    currentView: 'dashboard',
    currentShowId: null,
    currentSeason: 1,
    calendarWeekOffset: 0,
  });
});

// ---------- XSS: dashboard ----------

describe('XSS: dashboard render with malicious show data', () => {
  it('show.name HTML is escaped (no raw <img> element, no onerror attr) — FIXED', async () => {
    setShows([maliciousShow()]);
    const { renderDashboard } = await import('../src/views/dashboard');
    renderDashboard(document.getElementById('mainContent')!);
    // Check DOM structure (not innerHTML string — browser re-serializes aria-label
    // attributes with raw <> which is safe but breaks string-contains checks).
    expect(document.querySelectorAll('#mainContent img').length).toBe(0);
    expect(document.querySelectorAll('#mainContent [onerror]').length).toBe(0);
    expect(document.querySelectorAll('#mainContent script').length).toBe(0);
    // The visible text content must be the raw (escaped) name
    const nameEl = document.querySelector('.show-card-name');
    expect(nameEl!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('show-card-name is escapeHtml-encoded', async () => {
    setShows([maliciousShow()]);
    const { renderDashboard } = await import('../src/views/dashboard');
    renderDashboard(document.getElementById('mainContent')!);
    const nameEl = document.querySelector('.show-card-name');
    expect(nameEl).not.toBeNull();
    expect(nameEl!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(nameEl!.innerHTML).toContain('&lt;img');
  });

  it('show-card clickable div has NO onerror attribute on its children', async () => {
    setShows([maliciousShow()]);
    const { renderDashboard } = await import('../src/views/dashboard');
    renderDashboard(document.getElementById('mainContent')!);
    const onerrorAttrs = document.querySelectorAll('#mainContent [onerror]');
    expect(onerrorAttrs.length).toBe(0);
  });

  it('continue-card-name escapes show.name (continue watching section)', async () => {
    setShows([maliciousShow({
      list: 'watching',
      seasons: {
        1: [
          { num: 1, id: 11, watched: false, airdate: '2024-01-01', name: 'ep1', runtime: 45 },
        ],
      },
      totalEpisodes: 2,
    })]);
    const { renderDashboard } = await import('../src/views/dashboard');
    renderDashboard(document.getElementById('mainContent')!);
    const continueName = document.querySelector('.continue-card-name');
    expect(continueName).not.toBeNull();
    expect(continueName!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(continueName!.innerHTML).toContain('&lt;img');
  });
});

// ---------- XSS: showList ----------

describe('XSS: showList render with malicious show data', () => {
  it('title is escaped; show-card-name escaped', async () => {
    setShows([maliciousShow()]);
    const { renderShowList } = await import('../src/views/showList');
    renderShowList(document.getElementById('mainContent')!, 'watching', '<script>title</script>');
    const html = document.getElementById('mainContent')!.innerHTML;
    expect(html).not.toContain('<script>title</script>');
    expect(html).toContain('&lt;script&gt;title&lt;/script&gt;');
    const nameEl = document.querySelector('.show-card-name');
    expect(nameEl!.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

// ---------- XSS: showDetail ----------

describe('XSS: showDetail render with malicious show data', () => {
  beforeEach(() => {
    setShows([maliciousShow()]);
    getState().currentShowId = 1;
    getState().currentSeason = 1;
  });

  it('detail-name escapes show.name', async () => {
    const { renderShowDetail } = await import('../src/views/showDetail');
    renderShowDetail(document.getElementById('mainContent')!);
    const nameEl = document.querySelector('.detail-name');
    expect(nameEl!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(nameEl!.innerHTML).toContain('&lt;img');
  });

  it('status-badge escapes show.status (script tag neutralized)', async () => {
    const { renderShowDetail } = await import('../src/views/showDetail');
    renderShowDetail(document.getElementById('mainContent')!);
    const html = document.getElementById('mainContent')!.innerHTML;
    expect(html).not.toContain('<script>alert("status")</script>');
    expect(document.querySelectorAll('#mainContent script').length).toBe(0);
  });

  it('detail-summary escapes summary (script tag neutralized)', async () => {
    const { renderShowDetail } = await import('../src/views/showDetail');
    renderShowDetail(document.getElementById('mainContent')!);
    const html = document.getElementById('mainContent')!.innerHTML;
    expect(document.querySelectorAll('#mainContent script').length).toBe(0);
    expect(html).toContain('plain text');
  });

  it('network escapes show.network (no <a> tag in DOM)', async () => {
    const { renderShowDetail } = await import('../src/views/showDetail');
    renderShowDetail(document.getElementById('mainContent')!);
    expect(document.querySelectorAll('#mainContent a').length).toBe(0);
    const html = document.getElementById('mainContent')!.innerHTML;
    expect(html).toContain('&lt;a href=');
  });

  it('genre-tag escapes each genre', async () => {
    const { renderShowDetail } = await import('../src/views/showDetail');
    renderShowDetail(document.getElementById('mainContent')!);
    const tags = document.querySelectorAll('.genre-tag');
    expect(tags.length).toBe(2);
    expect(tags[0].textContent).toBe('<b>Drama</b>');
    expect(tags[0].innerHTML).toContain('&lt;b&gt;');
  });

  it('episode name escapes ep.name', async () => {
    const { renderShowDetail } = await import('../src/views/showDetail');
    renderShowDetail(document.getElementById('mainContent')!);
    const nameEl = document.querySelector('.episode-name');
    expect(nameEl).not.toBeNull();
    expect(nameEl!.innerHTML).toContain('&lt;img src=y onerror=alert(2)&gt;');
    expect(document.querySelectorAll('#mainContent [onerror]').length).toBe(0);
  });

  it('data-show-name attribute is escapeAttr-encoded (no <img> element created)', async () => {
    const { renderShowDetail } = await import('../src/views/showDetail');
    renderShowDetail(document.getElementById('mainContent')!);
    const removeBtn = document.querySelector('[data-action="removeShow"]') as HTMLElement;
    expect(removeBtn).not.toBeNull();
    const attr = removeBtn.dataset.showName;
    expect(attr).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelectorAll('#mainContent img').length).toBe(0);
    expect(document.querySelectorAll('#mainContent [onerror]').length).toBe(0);
  });
});

// ---------- XSS: modal body ----------

describe('XSS: modal body injection surface', () => {
  it('showModal injects bodyHtml raw (caller-controlled)', () => {
    showModal('Title', '<span id="evil">alert(1)</span>', [{ label: 'OK' }]);
    const evil = document.getElementById('evil');
    expect(evil).not.toBeNull(); // bodyHtml injected raw
    closeAllModals();
  });

  it('showModal title is set via textContent (HTML chars escaped)', () => {
    showModal('<img src=x onerror=alert(1)>', '<p>body</p>', [{ label: 'OK' }]);
    const titleEl = document.getElementById('modalTitle')!;
    expect(titleEl.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(titleEl.querySelectorAll('img').length).toBe(0);
    closeAllModals();
  });
});

// ---------- XSS: modal title via discover previewDiscover contract ----------

describe('XSS: discover previewDiscover title (show.name → showModal)', () => {
  it('TVMaze show.name with HTML is set as modal title via textContent (safe)', () => {
    const maliciousName = '<img src=z onerror=alert(3)>';
    showModal(maliciousName || 'Senza titolo', '<p>body</p>', [{ label: 'Chiudi' }]);
    const titleEl = document.getElementById('modalTitle')!;
    expect(titleEl.textContent).toBe(maliciousName);
    expect(titleEl.querySelectorAll('img').length).toBe(0);
    closeAllModals();
  });
});

// ---------- A11y: clickable divs are NOT keyboard-accessible ----------

describe('A11y: clickable divs now have role/tabindex (FIXED H17)', () => {
  it('dashboard .show-card has role=button and tabindex=0', async () => {
    setShows([maliciousShow()]);
    const { renderDashboard } = await import('../src/views/dashboard');
    renderDashboard(document.getElementById('mainContent')!);
    const card = document.querySelector('.show-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute('role')).toBe('button');
    expect(card.tabIndex).toBe(0);
  });

  it('dashboard .continue-card has role=button and tabindex=0', async () => {
    setShows([maliciousShow()]);
    const { renderDashboard } = await import('../src/views/dashboard');
    renderDashboard(document.getElementById('mainContent')!);
    const card = document.querySelector('.continue-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute('role')).toBe('button');
    expect(card.tabIndex).toBe(0);
  });

  it('showDetail .season-tab has role=tab and tabindex=0', async () => {
    setShows([maliciousShow()]);
    getState().currentShowId = 1;
    const { renderShowDetail } = await import('../src/views/showDetail');
    renderShowDetail(document.getElementById('mainContent')!);
    const tab = document.querySelector('.season-tab') as HTMLElement;
    expect(tab).not.toBeNull();
    expect(tab.getAttribute('role')).toBe('tab');
    expect(tab.tabIndex).toBe(0);
  });

  it('showDetail .episode-item (toggleEpisode) has role=button and tabindex=0', async () => {
    setShows([maliciousShow()]);
    getState().currentShowId = 1;
    const { renderShowDetail } = await import('../src/views/showDetail');
    renderShowDetail(document.getElementById('mainContent')!);
    const ep = document.querySelector('.episode-item[data-action="toggleEpisode"]') as HTMLElement;
    expect(ep).not.toBeNull();
    expect(ep.getAttribute('role')).toBe('button');
    expect(ep.tabIndex).toBe(0);
  });

  it('index.html nav-item (sidebar) has role=button and tabindex=0 (FIXED)', () => {
    const html = fs.readFileSync(
      path.resolve(__dirname, '..', 'index.html'),
      'utf-8',
    );
    const withRole = (html.match(/<div class="nav-item[^"]*"[^>]*role=/g) || []).length;
    expect(withRole).toBeGreaterThan(0);
    const withTabindex = (html.match(/<div class="nav-item[^"]*"[^>]*tabindex=/g) || []).length;
    expect(withTabindex).toBeGreaterThan(0);
  });
});

// ---------- Type-safety: Number() coercion on missing dataset ----------

describe('Type-safety: Number(dataset.x) returns NaN on missing attributes', () => {
  it('Number(undefined) is NaN (sanity)', () => {
    const el = document.createElement('div');
    expect(Number(el.dataset.showId)).toBeNaN();
    expect(Number(el.dataset.season)).toBeNaN();
    expect(Number(el.dataset.ep)).toBeNaN();
  });

  it('showDetail bind: click on element without data-show-id does NOT crash', async () => {
    setShows([maliciousShow()]);
    getState().currentShowId = 1;
    const { renderShowDetail, bindShowDetailEvents, resetBoundGuard } = await import('../src/views/showDetail');
    const main = document.getElementById('mainContent')!;
    renderShowDetail(main);
    resetBoundGuard();
    bindShowDetailEvents(main);

    const fake = document.createElement('div');
    fake.setAttribute('data-action', 'toggleEpisode');
    main.appendChild(fake);

    expect(() => fake.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
  });

  it('renderer bind: click with data-show-id missing → no openShow call', async () => {
    setShows([maliciousShow()]);
    const { initRenderer } = await import('../src/components/renderer');
    initRenderer();
    const main = document.getElementById('mainContent')!;

    const fake = document.createElement('div');
    fake.setAttribute('data-action', 'openShow');
    main.appendChild(fake);

    const beforeId = getState().currentShowId;
    fake.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(getState().currentShowId).toBe(beforeId);
  });
});

// ---------- Cross-module: progress clamp inconsistency ----------

describe('Cross-module: progress now clamped to [0,100] (FIXED BUG-13-01/14-02)', () => {
  it('dashboard: watched > totalEpisodes → progress width clamped to 100%', async () => {
    const show = maliciousShow({
      list: 'watching',
      seasons: {
        1: [
          { num: 1, id: 11, watched: true, airdate: '2024-01-01', name: 'a', runtime: 45 },
          { num: 2, id: 12, watched: true, airdate: '2024-01-08', name: 'b', runtime: 45 },
        ],
      },
      totalEpisodes: 1,
    });
    setShows([show]);
    const { renderDashboard } = await import('../src/views/dashboard');
    renderDashboard(document.getElementById('mainContent')!);
    const bar = document.querySelector('.show-card-progress-bar') as HTMLElement;
    expect(bar).not.toBeNull();
    const width = bar.getAttribute('style') || '';
    expect(width).toContain('width:100%');
    expect(width).not.toContain('200%');
  });

  it('showDetail: watched > totalEpisodes → progress width clamped to 100%', async () => {
    const show = maliciousShow({
      list: 'watching',
      seasons: {
        1: [
          { num: 1, id: 11, watched: true, airdate: '2024-01-01', name: 'a', runtime: 45 },
          { num: 2, id: 12, watched: true, airdate: '2024-01-08', name: 'b', runtime: 45 },
        ],
      },
      totalEpisodes: 1,
    });
    setShows([show]);
    getState().currentShowId = 1;
    const { renderShowDetail } = await import('../src/views/showDetail');
    renderShowDetail(document.getElementById('mainContent')!);
    const fill = document.querySelector('.detail-progress-fill') as HTMLElement;
    expect(fill).not.toBeNull();
    const width = fill.getAttribute('style') || '';
    expect(width).toContain('width:100%');
    expect(width).not.toContain('200%');
  });
});

// ---------- Cross-module: safeImageUrl not applied in discover/search render ----------

describe('Cross-module: safeImageUrl now applied in getPosterUrl (FIXED BUG-01-d/20-03)', () => {
  it('getPosterUrl filters javascript: URLs → null', async () => {
    const { getPosterUrl, safeImageUrl } = await import('../src/lib/utils');
    const malicious: TvmazeShow = {
      id: 1,
      name: 'X',
      image: { medium: 'javascript:alert(1)' },
    };
    // FIXED: getPosterUrl now wraps with safeImageUrl internally
    expect(getPosterUrl(malicious)).toBeNull();
    expect(safeImageUrl(getPosterUrl(malicious))).toBeNull();
  });

  it('getPosterUrl filters data: URLs → null', async () => {
    const { getPosterUrl, safeImageUrl } = await import('../src/lib/utils');
    const malicious: TvmazeShow = {
      id: 1,
      name: 'X',
      image: { medium: 'data:text/html,<script>alert(1)</script>' },
    };
    // FIXED: data: URLs rejected by safeImageUrl
    expect(getPosterUrl(malicious)).toBeNull();
    expect(safeImageUrl(getPosterUrl(malicious))).toBeNull();
  });

  it('escapeAttr does NOT filter URL scheme — discover/search vulnerable', async () => {
    const { escapeAttr, safeImageUrl } = await import('../src/lib/utils');
    const url = 'javascript:alert(1)';
    expect(escapeAttr(url)).toBe('javascript:alert(1)'); // unchanged
    expect(safeImageUrl(url)).toBeNull(); // would have filtered
  });
});

// ---------- Cross-module: three reconcilers divergence ----------

describe('Cross-module: reconcilers now agree on manualList (FIXED C1/H11)', () => {
  it('reconcileAllLists respects manualList — no silent override', async () => {
    const { reconcileAllLists } = await import('../src/lib/normalize');
    const { updateShowListStatus } = await import('../src/lib/store');

    const showA = maliciousShow({
      id: 1,
      list: 'completed',
      manualList: true,
      totalEpisodes: 0,
      seasons: {},
    });
    reconcileAllLists([showA]);
    // FIXED: manualList respected — stays completed
    expect(showA.list).toBe('completed');

    const showB = maliciousShow({
      id: 2,
      list: 'completed',
      manualList: true,
      totalEpisodes: 0,
      seasons: {},
    });
    updateShowListStatus(showB);
    expect(showB.list).toBe('completed');
  });

  it('reconcileAllLists clears manualList on auto-promotion (aligned with updateShowListStatus)', async () => {
    const { reconcileAllLists } = await import('../src/lib/normalize');
    const { updateShowListStatus } = await import('../src/lib/store');

    const showA = maliciousShow({
      id: 1,
      list: 'watching',
      manualList: true,
      totalEpisodes: 2,
      seasons: {
        1: [
          { num: 1, id: 11, watched: true, airdate: null, name: 'a', runtime: 45 },
          { num: 2, id: 12, watched: true, airdate: null, name: 'b', runtime: 45 },
        ],
      },
    });
    reconcileAllLists([showA]);
    expect(showA.list).toBe('completed');
    // FIXED: manualList cleared on auto-promotion
    expect(showA.manualList).toBe(false);

    const showB = maliciousShow({
      id: 2,
      list: 'watching',
      manualList: true,
      totalEpisodes: 2,
      seasons: {
        1: [
          { num: 1, id: 11, watched: true, airdate: null, name: 'a', runtime: 45 },
          { num: 2, id: 12, watched: true, airdate: null, name: 'b', runtime: 45 },
        ],
      },
    });
    updateShowListStatus(showB);
    expect(showB.list).toBe('completed');
    expect(showB.manualList).toBe(false);
  });
});

// ---------- Cross-module: showNeedsEpisodeNames misses empty string ----------

describe('Cross-module: showNeedsEpisodeNames now treats empty string as missing (FIXED BUG-06-03)', () => {
  it('returns true when ep.name === "" (treats empty as missing)', async () => {
    const { showNeedsEpisodeNames } = await import('../src/lib/shows');
    const show = maliciousShow({
      seasons: {
        1: [
          { num: 1, id: 11, watched: false, airdate: null, name: '', runtime: 45 },
        ],
      },
    });
    // FIXED: empty string now treated as missing → returns true
    expect(showNeedsEpisodeNames(show)).toBe(true);

    const showNull = maliciousShow({
      seasons: {
        1: [
          { num: 1, id: 11, watched: false, airdate: null, name: null, runtime: 45 },
        ],
      },
    });
    expect(showNeedsEpisodeNames(showNull)).toBe(true);
  });
});

// ---------- Cross-module: imageFallback data-fallbackFallbackCls never set ----------

describe('Cross-module: imageFallback dead branch removed (FIXED BUG-20-09)', () => {
  it('no caller reads or writes data-fallbackFallbackCls (dead branch removed)', () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    function walk(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(full));
        else if (e.name.endsWith('.ts')) out.push(full);
      }
      return out;
    }
    const files = walk(srcDir);
    let readCount = 0;
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf-8');
      if (content.includes('fallbackFallbackCls')) readCount++;
    }
    // FIXED: the dead data-fallbackFallbackCls branch was removed from imageFallback.ts
    expect(readCount).toBe(0);
  });
});

// ---------- A11y: toast is not aria-live ----------

describe('A11y: toast now has aria-live via JS (FIXED BUG-20-07)', () => {
  it('toast.ts sets role=status and aria-live=assertive at runtime', async () => {
    // The toast element in index.html may not have the attributes statically,
    // but toast.ts showToast() sets them idempotently. Import and call.
    const { showToast } = await import('../src/components/toast');
    showToast('test', 'success');
    const toast = document.getElementById('toast')!;
    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.getAttribute('aria-live')).toBe('assertive');
  });
});

// ---------- A11y: search results div not a listbox ----------

describe('A11y: search results now has listbox role via JS (FIXED BUG-20-08)', () => {
  it('search.ts initSearch sets role=listbox on results + combobox on input', async () => {
    // search-results div in index.html may lack static role, but search.ts
    // initSearch sets it. Verify by importing initSearch and calling it.
    document.body.insertAdjacentHTML('beforeend',
      '<div class="search-wrap"><input type="text" id="searchInput" maxlength="100"><div class="search-results" id="searchResults"></div></div>');
    const { initSearch } = await import('../src/components/search');
    initSearch();
    const results = document.getElementById('searchResults')!;
    expect(results.getAttribute('role')).toBe('listbox');
    const input = document.getElementById('searchInput') as HTMLInputElement;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    // cleanup
    document.querySelector('.search-wrap')?.remove();
  });
});

// ---------- A11y: sidebar nav landmark + nav-badge ----------

describe('A11y: sidebar nav landmark + nav-badge aria-label (FIXED BUG-20-10)', () => {
  it('index.html has <nav class="sidebar"> landmark (OK)', () => {
    const html = fs.readFileSync(
      path.resolve(__dirname, '..', 'index.html'),
      'utf-8',
    );
    expect(html).toContain('<nav class="sidebar"');
  });

  it('header.ts updateBadges sets aria-label dynamically on nav-badge spans', async () => {
    // nav-badge spans in index.html don't have static aria-label, but
    // header.ts updateBadges sets them dynamically. Verify via import.
    document.body.insertAdjacentHTML('beforeend',
      '<span class="nav-badge" id="badge-watching">0</span>' +
      '<span class="nav-badge" id="badge-towatch">0</span>' +
      '<span class="nav-badge" id="badge-completed">0</span>');
    const { updateBadges } = await import('../src/components/header');
    const { setShows } = await import('../src/lib/store');
    setShows([maliciousShow({ list: 'watching' }), maliciousShow({ id: 2, list: 'towatch' })]);
    updateBadges();
    const w = document.getElementById('badge-watching')!;
    expect(w.getAttribute('aria-label')).toBeTruthy();
    expect(w.getAttribute('aria-label')).toContain('1');
    document.getElementById('badge-watching')?.remove();
    document.getElementById('badge-towatch')?.remove();
    document.getElementById('badge-completed')?.remove();
  });
});
