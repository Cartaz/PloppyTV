// Contratto unico per documenti dati persistiti/importati.
// I moduli I/O decidono come leggere/scrivere; questo modulo decide se il
// contenuto è interpretabile dalla build corrente e produce Show canonici.

import type { Show } from '../types';
import { SCHEMA_VERSION } from './constants';
import { normalizeShow, reconcileAllLists } from './normalize';

export type DataDocumentErrorCode = 'invalid-document' | 'invalid-version' | 'unsupported-version' | 'invalid-shows';

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
  { ok: true; document: CanonicalDataDocument } | { ok: false; code: DataDocumentErrorCode; version?: unknown };

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
