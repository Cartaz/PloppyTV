// Agent A1 probe: bug hunt su src/lib/normalize.ts
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_a1.test.ts
//
// Ogni test dimostra un bug fixato (BUG-A1-xx). I test sono organizzati per
// bug ID in modo che il mapping fix→verifica sia immediato.

import { describe, it, expect } from 'vitest';
import { normalizeShow, buildShowFromTvmaze } from '../src/lib/normalize';
import type { TvmazeEpisode, TvmazeShow } from '../src/types';

// =============================================================================
// BUG-A1-01 [Medium] — buildShowFromTvmaze premiered loose regex
// Prima la regex `/^\d{4}-\d{2}-\d{2}$/` accettava qualsiasi combinazione di
// cifre, incluse date inesistenti (2024-13-40, 2024-02-30). Divergeva da
// normalizeShow (che usava parseISODateLocal). Fix: parseISODateLocal.
// =============================================================================

describe('BUG-A1-01 — buildShowFromTvmaze premiered rejects invalid dates', () => {
  const base: TvmazeShow = { id: 1, name: 'X', runtime: 60 };

  it('premiered "2024-13-40" (month 13) → null (FIXED, prima era accettato)', () => {
    const show = buildShowFromTvmaze({ ...base, premiered: '2024-13-40' }, [], 'towatch');
    expect(show.premiered).toBeNull();
  });

  it('premiered "2024-02-30" (Feb 30, rollover) → null (FIXED)', () => {
    const show = buildShowFromTvmaze({ ...base, premiered: '2024-02-30' }, [], 'towatch');
    expect(show.premiered).toBeNull();
  });

  it('premiered "2024-04-31" (Apr has 30 days) → null (FIXED)', () => {
    const show = buildShowFromTvmaze({ ...base, premiered: '2024-04-31' }, [], 'towatch');
    expect(show.premiered).toBeNull();
  });

  it('premiered "2024-00-15" (month 0) → null (FIXED)', () => {
    const show = buildShowFromTvmaze({ ...base, premiered: '2024-00-15' }, [], 'towatch');
    expect(show.premiered).toBeNull();
  });

  it('premiered "2024-06-15" (valid) → preserved', () => {
    const show = buildShowFromTvmaze({ ...base, premiered: '2024-06-15' }, [], 'towatch');
    expect(show.premiered).toBe('2024-06-15');
  });

  it('consistency: normalizeShow ALSO rejects "2024-13-40" (both paths aligned)', () => {
    expect(normalizeShow({ id: 1, premiered: '2024-13-40' })!.premiered).toBeNull();
    expect(normalizeShow({ id: 1, premiered: '2024-02-30' })!.premiered).toBeNull();
  });
});

// =============================================================================
// BUG-A1-02 [Medium] — buildShowFromTvmaze ep.airdate loose regex
// Stesso difetto di BUG-A1-01 ma per gli airdate degli episodi.
// =============================================================================

describe('BUG-A1-02 — buildShowFromTvmaze ep.airdate rejects invalid dates', () => {
  it('airdate "2024-13-40" → null (FIXED, prima era accettato)', () => {
    const eps: TvmazeEpisode[] = [{ id: 1, season: 1, number: 1, airdate: '2024-13-40' }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1][0].airdate).toBeNull();
  });

  it('airdate "2024-02-30" (Feb 30) → null (FIXED)', () => {
    const eps: TvmazeEpisode[] = [{ id: 1, season: 1, number: 1, airdate: '2024-02-30' }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1][0].airdate).toBeNull();
  });

  it('airdate "2024-06-15" (valid) → preserved', () => {
    const eps: TvmazeEpisode[] = [{ id: 1, season: 1, number: 1, airdate: '2024-06-15' }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1][0].airdate).toBe('2024-06-15');
  });

  it('airdate undefined → null (no crash)', () => {
    const eps: TvmazeEpisode[] = [{ id: 1, season: 1, number: 1 }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1][0].airdate).toBeNull();
  });
});

// =============================================================================
// BUG-A1-03 [Low] — ep.runtime accepts Infinity
// Il vecchio check `> 0` lasciava passare Infinity (Infinity > 0 === true),
// avvelenando i totali statistici (totalMinutes = Infinity). Fix: Number.isFinite.
// =============================================================================

describe('BUG-A1-03 — ep.runtime rejects Infinity/NaN', () => {
  it('normalizeShow: ep.runtime Infinity → null (FIXED, prima era Infinity)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, runtime: Infinity }] },
    });
    expect(out!.seasons[1][0].runtime).toBeNull();
  });

  it('normalizeShow: ep.runtime -Infinity → null', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, runtime: -Infinity }] },
    });
    expect(out!.seasons[1][0].runtime).toBeNull();
  });

  it('normalizeShow: ep.runtime NaN → null', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, runtime: NaN }] },
    });
    expect(out!.seasons[1][0].runtime).toBeNull();
  });

  it('normalizeShow: ep.runtime 60 (valid) → 60', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, runtime: 60 }] },
    });
    expect(out!.seasons[1][0].runtime).toBe(60);
  });

  it('buildShowFromTvmaze: ep.runtime Infinity → null (FIXED)', () => {
    const eps = [{ id: 1, season: 1, number: 1, runtime: Infinity }] as unknown as TvmazeEpisode[];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1][0].runtime).toBeNull();
  });

  it('buildShowFromTvmaze: ep.runtime NaN → null', () => {
    const eps = [{ id: 1, season: 1, number: 1, runtime: NaN }] as unknown as TvmazeEpisode[];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1][0].runtime).toBeNull();
  });
});

// =============================================================================
// BUG-A1-04 [Medium] — ep.watched "false"/"0" coercion to true
// Il vecchio `!!ep.watched` trattava le stringhe "false", "0", "null" come
// `true` (truthy in JS). Questo era incoerente con `getWatchedCount` (strict
// === true): dopo normalizeShow, l'episodio risultava `watched: true` ma il
// conteggio lo contava come watched → reconciliation/stats sballate.
// Fix: coerceWatched accetta solo true / "true" / 1.
// =============================================================================

describe('BUG-A1-04 — ep.watched strict coercion (no more "false" → true)', () => {
  it('watched "false" (string) → false (FIXED, prima era true via !!)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: 'false' }] },
    });
    expect(out!.seasons[1][0].watched).toBe(false);
  });

  it('watched "0" (string) → false (FIXED, prima era true)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: '0' }] },
    });
    expect(out!.seasons[1][0].watched).toBe(false);
  });

  it('watched "null" (string) → false (FIXED, prima era true)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: 'null' }] },
    });
    expect(out!.seasons[1][0].watched).toBe(false);
  });

  it('watched "undefined" (string) → false (FIXED)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: 'undefined' }] },
    });
    expect(out!.seasons[1][0].watched).toBe(false);
  });

  it('watched "yes" (string) → false (FIXED — non tra i valori accettati)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: 'yes' }] },
    });
    expect(out!.seasons[1][0].watched).toBe(false);
  });

  // Backward-compat: i test esistenti in probe_normalize.test.ts documentano
  // questi due casi. Verifichiamo che la fix non li rompa.
  it('watched "true" (string) → true (backward-compat preserved)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: 'true' }] },
    });
    expect(out!.seasons[1][0].watched).toBe(true);
  });

  it('watched 1 (number) → true (backward-compat preserved)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: 1 }] },
    });
    expect(out!.seasons[1][0].watched).toBe(true);
  });

  it('watched true (boolean) → true', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: true }] },
    });
    expect(out!.seasons[1][0].watched).toBe(true);
  });

  it('watched 0 (number) → false', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: 0 }] },
    });
    expect(out!.seasons[1][0].watched).toBe(false);
  });

  it('watched false (boolean) → false', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: false }] },
    });
    expect(out!.seasons[1][0].watched).toBe(false);
  });

  it('watched null → false', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: null }] },
    });
    expect(out!.seasons[1][0].watched).toBe(false);
  });

  it('watched undefined → false', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11 }] },
    });
    expect(out!.seasons[1][0].watched).toBe(false);
  });
});

// =============================================================================
// BUG-A1-05 [Low] — empty/whitespace name fallback to 'Senza titolo'
// Prima name vuoto dopo stripHtml (es. input "   " o "<p></p>") restava "".
// Incoerente col path non-string (che faceva fallback a 'Senza titolo').
// Fix: stripHtmlOrFallback ritorna il fallback se la stringa stripped è vuota.
// =============================================================================

describe('BUG-A1-05 — empty name fallback to Senza titolo', () => {
  it('normalizeShow: name "   " (whitespace) → "Senza titolo" (FIXED, prima era "")', () => {
    const out = normalizeShow({ id: 1, name: '   ' });
    expect(out!.name).toBe('Senza titolo');
  });

  it('normalizeShow: name "<p></p>" (empty HTML) → "Senza titolo" (FIXED)', () => {
    const out = normalizeShow({ id: 1, name: '<p></p>' });
    expect(out!.name).toBe('Senza titolo');
  });

  it('normalizeShow: name "<script></script>" → "Senza titolo" (FIXED)', () => {
    const out = normalizeShow({ id: 1, name: '<script></script>' });
    expect(out!.name).toBe('Senza titolo');
  });

  it('normalizeShow: name "" (empty string) → "Senza titolo" (FIXED)', () => {
    const out = normalizeShow({ id: 1, name: '' });
    expect(out!.name).toBe('Senza titolo');
  });

  it('normalizeShow: name "<b>Pilot</b>" → "Pilot" (HTML stripped, text kept)', () => {
    const out = normalizeShow({ id: 1, name: '<b>Pilot</b>' });
    expect(out!.name).toBe('Pilot');
  });

  it('normalizeShow: name "Pilot" (plain) → "Pilot" (preserved)', () => {
    const out = normalizeShow({ id: 1, name: 'Pilot' });
    expect(out!.name).toBe('Pilot');
  });

  it('buildShowFromTvmaze: name "   " → "Senza titolo" (FIXED)', () => {
    // "   " || 'Senza titolo' === "   " (truthy whitespace), stripHtml → "" → fallback
    const show = buildShowFromTvmaze({ id: 1, name: '   ', runtime: 60 }, [], 'towatch');
    expect(show.name).toBe('Senza titolo');
  });

  it('buildShowFromTvmaze: name "<p></p>" → "Senza titolo" (FIXED)', () => {
    const show = buildShowFromTvmaze({ id: 1, name: '<p></p>', runtime: 60 }, [], 'towatch');
    expect(show.name).toBe('Senza titolo');
  });

  it('buildShowFromTvmaze: name "<b>X</b>" → "X" (HTML stripped)', () => {
    const show = buildShowFromTvmaze({ id: 1, name: '<b>X</b>', runtime: 60 }, [], 'towatch');
    expect(show.name).toBe('X');
  });

  it('buildShowFromTvmaze: name "Test Show" → "Test Show" (preserved)', () => {
    const show = buildShowFromTvmaze({ id: 1, name: 'Test Show', runtime: 60 }, [], 'towatch');
    expect(show.name).toBe('Test Show');
  });
});

// =============================================================================
// BUG-A1-06 [Low] — empty status/network fallback to 'N/D'
// Stesso difetto di BUG-A1-05 ma per status e network.
// =============================================================================

describe('BUG-A1-06 — empty status/network fallback to N/D', () => {
  it('normalizeShow: status "   " → "N/D" (FIXED, prima era "")', () => {
    expect(normalizeShow({ id: 1, status: '   ' })!.status).toBe('N/D');
  });

  it('normalizeShow: status "<p></p>" → "N/D" (FIXED)', () => {
    expect(normalizeShow({ id: 1, status: '<p></p>' })!.status).toBe('N/D');
  });

  it('normalizeShow: status "<b>Running</b>" → "Running" (preserved)', () => {
    expect(normalizeShow({ id: 1, status: '<b>Running</b>' })!.status).toBe('Running');
  });

  it('normalizeShow: network "   " → "N/D" (FIXED, prima era "")', () => {
    expect(normalizeShow({ id: 1, network: '   ' })!.network).toBe('N/D');
  });

  it('normalizeShow: network "<i></i>" → "N/D" (FIXED)', () => {
    expect(normalizeShow({ id: 1, network: '<i></i>' })!.network).toBe('N/D');
  });

  it('normalizeShow: network "<i>HBO</i>" → "HBO" (preserved)', () => {
    expect(normalizeShow({ id: 1, network: '<i>HBO</i>' })!.network).toBe('HBO');
  });

  it('buildShowFromTvmaze: status "   " → "N/D" (FIXED)', () => {
    const show = buildShowFromTvmaze({ id: 1, name: 'X', status: '   ', runtime: 60 }, [], 'towatch');
    expect(show.status).toBe('N/D');
  });

  it('buildShowFromTvmaze: status "<p></p>" → "N/D" (FIXED)', () => {
    const show = buildShowFromTvmaze({ id: 1, name: 'X', status: '<p></p>', runtime: 60 }, [], 'towatch');
    expect(show.status).toBe('N/D');
  });

  it('buildShowFromTvmaze: network.name "   " → "N/D" (FIXED)', () => {
    const show = buildShowFromTvmaze(
      { id: 1, name: 'X', runtime: 60, network: { name: '   ' } },
      [],
      'towatch',
    );
    expect(show.network).toBe('N/D');
  });

  it('buildShowFromTvmaze: network.name "<a></a>" → "N/D" (FIXED)', () => {
    const show = buildShowFromTvmaze(
      { id: 1, name: 'X', runtime: 60, network: { name: '<a></a>' } },
      [],
      'towatch',
    );
    expect(show.network).toBe('N/D');
  });

  it('buildShowFromTvmaze: webChannel.name "   " (network missing) → "N/D" (FIXED)', () => {
    const show = buildShowFromTvmaze(
      { id: 1, name: 'X', runtime: 60, webChannel: { name: '   ' } },
      [],
      'towatch',
    );
    expect(show.network).toBe('N/D');
  });

  it('buildShowFromTvmaze: network.name "<b>HBO</b>" → "HBO" (preserved)', () => {
    const show = buildShowFromTvmaze(
      { id: 1, name: 'X', runtime: 60, network: { name: '<b>HBO</b>' } },
      [],
      'towatch',
    );
    expect(show.network).toBe('HBO');
  });
});

// =============================================================================
// BUG-A1-07 [Medium] — ep.name not stripHtml'd (XSS defense-in-depth)
// Il nome episodio NON veniva stripHtml'd né in normalizeShow né in
// buildShowFromTvmaze. Era un gap rispetto a summary/show-name (che sono
// stripHtml'd). Se il renderer avesse dimenticato l'escapeHtml, sarebbe
// stato XSS. Fix: safeEpisodeName applica stripHtml + fallback null se vuoto.
// =============================================================================

describe('BUG-A1-07 — ep.name stripHtml + null fallback', () => {
  it('normalizeShow: ep.name "<script>alert(1)</script>Pilot" → "Pilot" (FIXED, prima era raw)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, name: '<script>alert(1)</script>Pilot' }] },
    });
    expect(out!.seasons[1][0].name).toBe('Pilot');
  });

  it('normalizeShow: ep.name "<b>Pilot</b>" → "Pilot" (FIXED)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, name: '<b>Pilot</b>' }] },
    });
    expect(out!.seasons[1][0].name).toBe('Pilot');
  });

  it('normalizeShow: ep.name "<img src=x onerror=alert(1)>" → null (FIXED, prima era raw HTML)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, name: '<img src=x onerror=alert(1)>' }] },
    });
    expect(out!.seasons[1][0].name).toBeNull();
  });

  it('normalizeShow: ep.name "<p></p>" (empty HTML) → null (FIXED, prima era "")', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, name: '<p></p>' }] },
    });
    expect(out!.seasons[1][0].name).toBeNull();
  });

  it('normalizeShow: ep.name "   " (whitespace) → null (FIXED, prima era "")', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, name: '   ' }] },
    });
    expect(out!.seasons[1][0].name).toBeNull();
  });

  it('normalizeShow: ep.name "Pilot" (plain) → "Pilot" (preserved)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, name: 'Pilot' }] },
    });
    expect(out!.seasons[1][0].name).toBe('Pilot');
  });

  it('normalizeShow: ep.name 123 (non-string) → null (backward-compat preserved)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, name: 123 }] },
    });
    expect(out!.seasons[1][0].name).toBeNull();
  });

  it('buildShowFromTvmaze: ep.name "<b>Pilot</b>" → "Pilot" (FIXED)', () => {
    const eps: TvmazeEpisode[] = [{ id: 1, season: 1, number: 1, name: '<b>Pilot</b>' }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1][0].name).toBe('Pilot');
  });

  it('buildShowFromTvmaze: ep.name "<script>x</script>" → null (FIXED)', () => {
    const eps: TvmazeEpisode[] = [{ id: 1, season: 1, number: 1, name: '<script>x</script>' }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1][0].name).toBeNull();
  });

  it('buildShowFromTvmaze: ep.name "Pilot" → "Pilot" (preserved)', () => {
    const eps: TvmazeEpisode[] = [{ id: 1, season: 1, number: 1, name: 'Pilot' }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1][0].name).toBe('Pilot');
  });

  it('buildShowFromTvmaze: ep.name undefined → null (no crash)', () => {
    const eps: TvmazeEpisode[] = [{ id: 1, season: 1, number: 1 }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1][0].name).toBeNull();
  });
});

// =============================================================================
// BUG-A1-08 [Medium] — ep.note not stripHtml'd (XSS defense-in-depth)
// Le note utente non venivano stripHtml'd. Se importate da backup malevolo,
// potevano contenere HTML grezzo. Fix: stripHtml prima di slice + trim check.
// =============================================================================

describe('BUG-A1-08 — ep.note stripHtml', () => {
  it('note "<script>alert(1)</script>hello" → "hello" (FIXED, prima era raw)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, note: '<script>alert(1)</script>hello' }] },
    });
    expect(out!.seasons[1][0].note).toBe('hello');
  });

  it('note "<b>spoiler</b>" → "spoiler" (FIXED)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, note: '<b>spoiler</b>' }] },
    });
    expect(out!.seasons[1][0].note).toBe('spoiler');
  });

  it('note "<img src=x onerror=alert(1)>" → undefined (FIXED, prima era raw HTML)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, note: '<img src=x onerror=alert(1)>' }] },
    });
    expect(out!.seasons[1][0].note).toBeUndefined();
  });

  it('note "<p></p>" (empty HTML) → undefined (FIXED, prima era "")', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, note: '<p></p>' }] },
    });
    expect(out!.seasons[1][0].note).toBeUndefined();
  });

  it('note "   <b>x</b>   " → "x" (HTML stripped, trimmed check on stripped)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, note: '   <b>x</b>   ' }] },
    });
    expect(out!.seasons[1][0].note).toBe('x');
  });

  it('note "plain text" → "plain text" (preserved)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, note: 'plain text' }] },
    });
    expect(out!.seasons[1][0].note).toBe('plain text');
  });

  it('note "   " (whitespace) → undefined (backward-compat preserved)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, note: '   ' }] },
    });
    expect(out!.seasons[1][0].note).toBeUndefined();
  });

  it('note long non-HTML → still sliced to MAX_EPISODE_NOTE_LENGTH (backward-compat)', async () => {
    const { MAX_EPISODE_NOTE_LENGTH } = await import('../src/lib/constants');
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, note: 'a'.repeat(600) }] },
    });
    expect(out!.seasons[1][0].note).toHaveLength(MAX_EPISODE_NOTE_LENGTH);
  });
});

// =============================================================================
// BUG-A1-09 [Medium] — tags not stripHtml'd (XSS defense-in-depth)
// I tag utente non venivano stripHtml'd. Fix: stripHtml + trim + length check.
// =============================================================================

describe('BUG-A1-09 — tags stripHtml', () => {
  it('tag "<b>bold</b>" → "bold" (FIXED, prima era raw "<b>bold</b>")', () => {
    const out = normalizeShow({ id: 1, tags: ['<b>bold</b>'] });
    expect(out!.tags).toEqual(['bold']);
  });

  it('tag "<script>alert(1)</script>evil" → "evil" (FIXED)', () => {
    const out = normalizeShow({ id: 1, tags: ['<script>alert(1)</script>evil'] });
    expect(out!.tags).toEqual(['evil']);
  });

  it('tag "<img src=x onerror=alert(1)>" → filtered out (FIXED, prima era raw)', () => {
    const out = normalizeShow({ id: 1, tags: ['<img src=x onerror=alert(1)>', 'ok'] });
    expect(out!.tags).toEqual(['ok']);
  });

  it('tag "<p></p>" (empty HTML) → filtered out (FIXED)', () => {
    const out = normalizeShow({ id: 1, tags: ['<p></p>', 'ok'] });
    expect(out!.tags).toEqual(['ok']);
  });

  it('tag "   <b>x</b>   " → "x" (HTML stripped, then trimmed)', () => {
    const out = normalizeShow({ id: 1, tags: ['   <b>x</b>   '] });
    expect(out!.tags).toEqual(['x']);
  });

  it('tag "plain" → "plain" (preserved)', () => {
    const out = normalizeShow({ id: 1, tags: ['plain'] });
    expect(out!.tags).toEqual(['plain']);
  });

  it('tags dedup still works after stripHtml', () => {
    const out = normalizeShow({ id: 1, tags: ['<b>Rewatch</b>', 'rewatch', 'Rewatch'] });
    // stripHtml('<b>Rewatch</b>') = 'Rewatch', dedup case-insensitive with 'rewatch' → 1 tag
    expect(out!.tags).toEqual(['Rewatch']);
  });

  it('tags non-string filtered (backward-compat)', () => {
    const out = normalizeShow({ id: 1, tags: [123, null, 'ok', '<b>good</b>'] as unknown as string[] });
    expect(out!.tags).toEqual(['ok', 'good']);
  });

  it('tag long non-HTML → still sliced to MAX_TAG_LENGTH (backward-compat)', async () => {
    const { MAX_TAG_LENGTH } = await import('../src/lib/constants');
    const out = normalizeShow({ id: 1, tags: ['x'.repeat(100)] });
    expect(out!.tags![0]).toHaveLength(MAX_TAG_LENGTH);
  });
});

// =============================================================================
// BUG-A1-10 [Low] — buildShowFromTvmaze null ep in episodes array
// Un episodio null/undefined nell'array (API corrotta) faceva throw su
// ep.season prima di ogni guard. Fix: `if (ep == null) continue;` in testa al loop.
// =============================================================================

describe('BUG-A1-10 — buildShowFromTvmaze skips null ep entries', () => {
  it('episodes array contains null → skipped, no throw (FIXED)', () => {
    const eps = [null, { id: 1, season: 1, number: 1, name: 'Pilot' }] as unknown as TvmazeEpisode[];
    expect(() => buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch')).not.toThrow();
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.totalEpisodes).toBe(1);
    expect(show.seasons[1][0].name).toBe('Pilot');
  });

  it('episodes array contains undefined → skipped, no throw (FIXED)', () => {
    const eps = [undefined, { id: 1, season: 1, number: 1 }] as unknown as TvmazeEpisode[];
    expect(() => buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch')).not.toThrow();
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.totalEpisodes).toBe(1);
  });

  it('episodes array with nulls interspersed → valid eps kept', () => {
    const eps = [
      { id: 1, season: 1, number: 1, name: 'A' },
      null,
      { id: 2, season: 1, number: 2, name: 'B' },
      undefined,
      { id: 3, season: 1, number: 3, name: 'C' },
    ] as unknown as TvmazeEpisode[];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.totalEpisodes).toBe(3);
    expect(show.seasons[1].map((e) => e.name)).toEqual(['A', 'B', 'C']);
  });

  it('episodes array all null → no episodes, no throw', () => {
    const eps = [null, null, null] as unknown as TvmazeEpisode[];
    expect(() => buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch')).not.toThrow();
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    expect(show.totalEpisodes).toBe(0);
    expect(show.totalSeasons).toBe(0);
  });
});

// =============================================================================
// Extra edge cases — cross-checks that the fixes work together
// =============================================================================

describe('Cross-checks — combined edge cases', () => {
  it('normalizeShow: fully malicious episode is fully sanitized', () => {
    const out = normalizeShow({
      id: 1,
      seasons: {
        1: [
          {
            num: 1,
            id: 11,
            watched: 'false', // BUG-A1-04: → false
            airdate: '2024-13-40', // already rejected
            name: '<script>x</script>Pilot', // BUG-A1-07: → "Pilot"
            runtime: Infinity, // BUG-A1-03: → null
            note: '<b>spoiler</b>', // BUG-A1-08: → "spoiler"
            rating: 3,
          },
        ],
      },
    });
    expect(out).not.toBeNull();
    const ep = out!.seasons[1][0];
    expect(ep.watched).toBe(false);
    expect(ep.airdate).toBeNull();
    expect(ep.name).toBe('Pilot');
    expect(ep.runtime).toBeNull();
    expect(ep.note).toBe('spoiler');
    expect(ep.rating).toBe(3);
  });

  it('buildShowFromTvmaze: fully malicious show is fully sanitized', () => {
    const tvmaze: TvmazeShow = {
      id: 1,
      name: '<script></script>', // BUG-A1-05: → "Senza titolo"
      status: '<p></p>', // BUG-A1-06: → "N/D"
      premiered: '2024-13-40', // BUG-A1-01: → null
      network: { name: '<a></a>' }, // BUG-A1-06: → "N/D"
      runtime: 60,
      summary: '<script>evil()</script>plain',
    };
    const eps: TvmazeEpisode[] = [
      null, // BUG-A1-10: skipped
      { id: 1, season: 1, number: 1, name: '<b>Pilot</b>', airdate: '2024-02-30', runtime: Infinity },
    ] as unknown as TvmazeEpisode[];
    const show = buildShowFromTvmaze(tvmaze, eps, 'towatch');
    expect(show.name).toBe('Senza titolo');
    expect(show.status).toBe('N/D');
    expect(show.premiered).toBeNull();
    expect(show.network).toBe('N/D');
    expect(show.summary).toBe('plain');
    expect(show.totalEpisodes).toBe(1);
    expect(show.seasons[1][0].name).toBe('Pilot');
    expect(show.seasons[1][0].airdate).toBeNull();
    expect(show.seasons[1][0].runtime).toBeNull();
  });

  it('normalizeShow with __proto__/constructor keys: no prototype pollution', () => {
    // JSON.parse può produrre oggetti con chiave "__proto__" come own property.
    // safeId rigetta le chiavi non numeriche → nessuna scrittura su seasons.
    const out = normalizeShow({
      id: 1,
      seasons: {
        __proto__: [{ num: 1, id: 11 }], // key non numerica → rigettata
        constructor: [{ num: 2, id: 22 }], // key non numerica → rigettata
        '1': [{ num: 1, id: 33 }],
      },
    });
    expect(out).not.toBeNull();
    expect(Object.keys(out!.seasons)).toEqual(['1']);
    expect(out!.seasons[1][0].id).toBe(33);
    // Verify prototype not polluted
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('normalizeShow: episode num "1" (string) still works via safeId', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: '1', id: 11 }] },
    });
    expect(out!.seasons[1][0].num).toBe(1);
  });

  it('normalizeShow: rating NaN/Infinity → undefined (no rating set)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: {
        1: [
          { num: 1, id: 11, rating: NaN },
          { num: 2, id: 12, rating: Infinity },
          { num: 3, id: 13, rating: 3 },
        ],
      },
    });
    expect(out!.seasons[1][0].rating).toBeUndefined();
    expect(out!.seasons[1][1].rating).toBeUndefined();
    expect(out!.seasons[1][2].rating).toBe(3);
  });
});
