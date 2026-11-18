// L'interfaccia è interamente tradotta: ogni chiave usata esiste in entrambe le
// lingue e le viste in inglese non contengono testo italiano.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import itDict from '../src/locales/it.json';
import enDict from '../src/locales/en.json';

const IT = itDict as Record<string, string>;
const EN = enDict as Record<string, string>;

vi.mock('../src/lib/storage', () => ({ saveData: vi.fn(() => true), isStorageOK: vi.fn(() => true) }));

import { setLocale, initI18n } from '../src/lib/i18n';
import { setShows, setState } from '../src/lib/store';
import { renderDashboard } from '../src/views/dashboard';
import { renderShowDetail } from '../src/views/showDetail';
import { renderShowList } from '../src/views/showList';
import { renderLibrary } from '../src/views/library';
import { renderDiscover } from '../src/views/discover';
import { renderYearReview } from '../src/views/yearReview';
import { makeShowWithSeasons, markWatchedFirst } from './helpers';

const ROOT = resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of [...sourceFiles(join(ROOT, 'src')), join(ROOT, 'index.html')]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?<![\w.])t\('([\w.]+)'/g)) keys.add(m[1]);
    for (const m of src.matchAll(/(?<![\w.])tn\('([\w.]+)'/g)) keys.add(m[1] + '.one').add(m[1] + '.other');
    for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([\w.]+)"/g)) keys.add(m[1]);
  }
  return keys;
}

describe('locale dictionaries', () => {
  it('define every key used by the code, in both languages', () => {
    const keys = [...usedKeys()];
    expect(keys.length).toBeGreaterThan(200);
    expect(keys.filter((k) => !(k in IT))).toEqual([]);
    expect(keys.filter((k) => !(k in EN))).toEqual([]);
  });

  it('use the same placeholders in Italian and English', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const mismatched = Object.keys(IT).filter(
      (k) => JSON.stringify(placeholders(IT[k])) !== JSON.stringify(placeholders(EN[k] ?? '')),
    );
    expect(mismatched).toEqual([]);
  });
});

describe('English UI', () => {
  // Parole che compaiono solo nei testi italiani dell'interfaccia.
  const ITALIAN =
    /\b(Stagione|Episodio|episodi|Calendario|Statistiche|Da vedere|In corso|Completat[ae]|Aggiungi|Rimuovi|Segna|Prossimo|Continua|Scopri|Libreria|Nessun[ao]?|Serie)\b/;
  let main: HTMLElement;

  beforeAll(() => {
    document.body.innerHTML = '<main id="mainContent"></main><div id="toast"></div>';
    main = document.getElementById('mainContent')!;
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    initI18n();
    setLocale('en');
    const s = makeShowWithSeasons({ 1: 3, 2: 1 }, { id: 1, name: 'Show', list: 'watching', tags: ['Rewatch'] });
    markWatchedFirst(s, 1, 1);
    s.seasons[1][0].rating = 5;
    s.seasons[1][0].airdate = '2025-03-01';
    setShows([s, makeShowWithSeasons({ 1: 1 }, { id: 2, name: 'Other', list: 'towatch' })]);
  });

  it.each([
    ['dashboard', () => renderDashboard(main)],
    ['show list', () => renderShowList(main, 'watching', 'Watching')],
    ['library', () => renderLibrary(main)],
    ['discover', () => renderDiscover(main)],
    ['year in review', () => renderYearReview(main)],
    [
      'show detail',
      () => {
        setState({ currentShowId: 1, currentSeason: 1 });
        renderShowDetail(main);
      },
    ],
  ])('%s has no Italian text', (_name, render) => {
    render();
    const text = main.textContent ?? '';
    expect(text.length).toBeGreaterThan(20);
    expect(text).not.toMatch(ITALIAN);
  });
});
