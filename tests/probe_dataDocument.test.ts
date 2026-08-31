import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../src/lib/constants';
import { canonicalizeDataDocument } from '../src/lib/dataDocument';

function show(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Show ${id}`,
    image: null,
    status: 'Running',
    premiered: '2024-01-01',
    genres: ['Drama'],
    summary: '',
    network: 'N/D',
    runtime: 45,
    list: 'towatch',
    manualList: false,
    seasons: {},
    addedAt: 1700000000000,
    ...over,
  };
}

describe('canonicalizeDataDocument', () => {
  it.each([null, [], 'x', 42])('rejects non-object envelope: %p', (value) => {
    expect(canonicalizeDataDocument(value)).toEqual({ ok: false, code: 'invalid-document' });
  });

  it('requires shows to be an array', () => {
    expect(canonicalizeDataDocument({ version: SCHEMA_VERSION, shows: null })).toEqual({
      ok: false,
      code: 'invalid-shows',
    });
  });

  it.each(['2', 0, -1, 1.5, NaN, Infinity])('rejects invalid schema version: %p', (version) => {
    const result = canonicalizeDataDocument({ version, shows: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-version');
  });

  it('fails closed on future schema versions', () => {
    expect(canonicalizeDataDocument({ version: SCHEMA_VERSION + 1, shows: [] })).toEqual({
      ok: false,
      code: 'unsupported-version',
      version: SCHEMA_VERSION + 1,
    });
  });

  it('accepts an unversioned legacy document and emits the current canonical version', () => {
    const result = canonicalizeDataDocument({ shows: [show(1)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(SCHEMA_VERSION);
    expect(result.document.sourceVersion).toBeNull();
    expect(result.document.shows).toHaveLength(1);
  });

  it('accepts schema v1 and normalizes it to the current model', () => {
    const result = canonicalizeDataDocument({ version: 1, shows: [show(1, { tags: undefined })] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sourceVersion).toBe(1);
    expect(result.document.version).toBe(SCHEMA_VERSION);
    expect(result.document.shows[0].tags).toEqual([]);
  });

  it('skips invalid shows and reports the count', () => {
    const result = canonicalizeDataDocument({ version: SCHEMA_VERSION, shows: [show(1), null, { id: 0 }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.inputShows).toBe(3);
    expect(result.document.skippedShows).toBe(2);
    expect(result.document.shows.map((item) => item.id)).toEqual([1]);
  });

  it('deduplicates by id with first-wins semantics', () => {
    const result = canonicalizeDataDocument({
      version: SCHEMA_VERSION,
      shows: [show(1, { name: 'First' }), show(1, { name: 'Second' }), show(2)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.duplicateShows).toBe(1);
    expect(result.document.shows.map((item) => item.name)).toEqual(['First', 'Show 2']);
  });

  it('reconciles lists as part of canonicalization', () => {
    const result = canonicalizeDataDocument({
      version: SCHEMA_VERSION,
      shows: [
        show(1, {
          list: 'watching',
          seasons: {
            1: [{ num: 1, id: 11, watched: true, airdate: '2024-01-01' }],
          },
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.shows[0].list).toBe('completed');
  });
});
