from pathlib import Path

Path("src/lib/dataDocument.ts").write_text(r'''// Contratto unico per documenti dati persistiti/importati.
// I moduli I/O decidono come leggere/scrivere; questo modulo decide se il
// contenuto è interpretabile dalla build corrente e produce Show canonici.

import type { Show } from '../types';
import { SCHEMA_VERSION } from './constants';
import { normalizeShow, reconcileAllLists } from './normalize';

export type DataDocumentErrorCode =
  | 'invalid-document'
  | 'invalid-version'
  | 'unsupported-version'
  | 'invalid-shows';

export interface CanonicalDataDocument {
  version: number;
  /** null = documento storico senza campo version. */
  sourceVersion: number | null;
  shows: Show[];
  inputShows: number;
  skippedShows: number;
  duplicateShows: number;
}

export type DataDocumentResult =
  | { ok: true; document: CanonicalDataDocument }
  | { ok: false; code: DataDocumentErrorCode; version?: unknown };

/**
 * Porta un envelope dati non fidato al modello canonico corrente.
 *
 * Policy schema:
 * - version mancante: legacy supportato; normalizeShow applica i default correnti;
 * - version: intero positivo <= SCHEMA_VERSION;
 * - version futura/non valida: fail closed;
 * - shows: deve essere un array; elementi invalidi vengono scartati;
 * - id duplicati: first wins; list reconciliation eseguita una sola volta qui.
 */
export function canonicalizeDataDocument(input: unknown): DataDocumentResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'invalid-document' };
  }

  const raw = input as Record<string, unknown>;
  let sourceVersion: number | null = null;
  if (raw.version !== undefined) {
    if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
      return { ok: false, code: 'invalid-version', version: raw.version };
    }
    if (raw.version > SCHEMA_VERSION) {
      return { ok: false, code: 'unsupported-version', version: raw.version };
    }
    sourceVersion = raw.version;
  }

  if (!Array.isArray(raw.shows)) {
    return { ok: false, code: 'invalid-shows' };
  }

  const normalized = raw.shows.map(normalizeShow).filter((show): show is Show => show !== null);
  const seen = new Set<number>();
  const shows: Show[] = [];
  let duplicateShows = 0;
  for (const show of normalized) {
    if (seen.has(show.id)) {
      duplicateShows++;
      continue;
    }
    seen.add(show.id);
    shows.push(show);
  }

  reconcileAllLists(shows);

  return {
    ok: true,
    document: {
      version: SCHEMA_VERSION,
      sourceVersion,
      shows,
      inputShows: raw.shows.length,
      skippedShows: raw.shows.length - normalized.length,
      duplicateShows,
    },
  };
}
''')

Path("tests/probe_dataDocument.test.ts").write_text(r'''import { describe, expect, it } from 'vitest';
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
''')
