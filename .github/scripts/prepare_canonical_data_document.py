from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    src = p.read_text()
    if src.count(old) != 1:
        raise SystemExit(f"{path}: expected anchor exactly once: {old[:100]!r}")
    p.write_text(src.replace(old, new, 1))


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    p = Path(path)
    src = p.read_text()
    start_idx = src.find(start)
    end_idx = src.find(end, start_idx + len(start)) if start_idx >= 0 else -1
    if start_idx < 0 or end_idx < 0:
        raise SystemExit(f"{path}: range anchors not found: {start!r} -> {end!r}")
    p.write_text(src[:start_idx] + replacement + src[end_idx:])


Path("src/lib/dataDocument.ts").write_text(
    """// Contratto unico per documenti dati persistiti/importati.\n"
    "// I moduli I/O decidono come leggere/scrivere; questo modulo decide se il\n"
    "// contenuto e' interpretabile dalla build corrente e produce Show canonici.\n\n"
    "import type { Show } from '../types';\n"
    "import { SCHEMA_VERSION } from './constants';\n"
    "import { normalizeShow, reconcileAllLists } from './normalize';\n\n"
    "export type DataDocumentErrorCode =\n"
    "  | 'invalid-document'\n"
    "  | 'invalid-version'\n"
    "  | 'unsupported-version'\n"
    "  | 'invalid-shows';\n\n"
    "export interface CanonicalDataDocument {\n"
    "  version: number;\n"
    "  /** null = documento storico senza campo version. */\n"
    "  sourceVersion: number | null;\n"
    "  shows: Show[];\n"
    "  inputShows: number;\n"
    "  skippedShows: number;\n"
    "  duplicateShows: number;\n"
    "}\n\n"
    "export type DataDocumentResult =\n"
    "  | { ok: true; document: CanonicalDataDocument }\n"
    "  | { ok: false; code: DataDocumentErrorCode; version?: unknown };\n\n"
    "/**\n"
    " * Porta un envelope dati non fidato al modello canonico corrente.\n"
    " *\n"
    " * Policy schema:\n"
    " * - version mancante: legacy supportato; normalizeShow applica i default correnti;\n"
    " * - version: intero positivo <= SCHEMA_VERSION;\n"
    " * - version futura/non valida: fail closed;\n"
    " * - shows: deve essere un array; elementi invalidi vengono scartati;\n"
    " * - id duplicati: first wins; list reconciliation eseguita una sola volta qui.\n"
    " */\n"
    "export function canonicalizeDataDocument(input: unknown): DataDocumentResult {\n"
    "  if (!input || typeof input !== 'object' || Array.isArray(input)) {\n"
    "    return { ok: false, code: 'invalid-document' };\n"
    "  }\n\n"
    "  const raw = input as Record<string, unknown>;\n"
    "  let sourceVersion: number | null = null;\n"
    "  if (raw.version !== undefined) {\n"
    "    if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {\n"
    "      return { ok: false, code: 'invalid-version', version: raw.version };\n"
    "    }\n"
    "    if (raw.version > SCHEMA_VERSION) {\n"
    "      return { ok: false, code: 'unsupported-version', version: raw.version };\n"
    "    }\n"
    "    sourceVersion = raw.version;\n"
    "  }\n\n"
    "  if (!Array.isArray(raw.shows)) {\n"
    "    return { ok: false, code: 'invalid-shows' };\n"
    "  }\n\n"
    "  const normalized = raw.shows.map(normalizeShow).filter((show): show is Show => show !== null);\n"
    "  const seen = new Set<number>();\n"
    "  const shows: Show[] = [];\n"
    "  let duplicateShows = 0;\n"
    "  for (const show of normalized) {\n"
    "    if (seen.has(show.id)) {\n"
    "      duplicateShows++;\n"
    "      continue;\n"
    "    }\n"
    "    seen.add(show.id);\n"
    "    shows.push(show);\n"
    "  }\n\n"
    "  reconcileAllLists(shows);\n\n"
    "  return {\n"
    "    ok: true,\n"
    "    document: {\n"
    "      version: SCHEMA_VERSION,\n"
    "      sourceVersion,\n"
    "      shows,\n"
    "      inputShows: raw.shows.length,\n"
    "      skippedShows: raw.shows.length - normalized.length,\n"
    "      duplicateShows,\n"
    "    },\n"
    "  };\n"
    "}\n"
    """
)

# storage.ts: replace duplicated schema/normalization policy with the canonical contract.
replace_once(
    "src/lib/storage.ts",
    "import { normalizeShow, reconcileAllLists } from './normalize';\n",
    "import { canonicalizeDataDocument } from './dataDocument';\n",
)
replace_between(
    "src/lib/storage.ts",
    "/**\n * BUG-A19-04: dedup show per id (keep first).\n",
    "/**\n * Salva lo stato corrente su localStorage.\n",
    "",
)
replace_once(
    "src/lib/storage.ts",
    """function _loadFromBackup(): SavedData | null {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? (JSON.parse(raw) as SavedData) : null;
  } catch {
    return null;
  }
}
""",
    """function _loadFromBackup(): unknown | null {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function _loadCanonicalBackup(): Show[] | null {
  const result = canonicalizeDataDocument(_loadFromBackup());
  return result.ok && result.document.shows.length > 0 ? result.document.shows : null;
}
""",
)
replace_once("src/lib/storage.ts", "  let parsed: SavedData;\n", "  let parsed: unknown;\n")
replace_once(
    "src/lib/storage.ts",
    """    const backup = _loadFromBackup();
    if (backup && Array.isArray(backup.shows) && backup.shows.length > 0) {
      const shows = backup.shows.map(normalizeShow).filter((s): s is Show => s !== null);
      reconcileAllLists(shows);
      // BUG-A4-06: valida tipo di backup.savedAt — non trustare stringhe/NaN
      // (un backup vecchio o malevolo con savedAt="abc" romperebbe il CAS
      // perché "abc" !== <numero> è sempre true → ogni save futuro rifiutato).
      setShows(shows);
      showToast('Dati corrotti. Ripristinato backup precedente.', 'warning');
      saveData({ immediate: true });
      return;
    }
""",
    """    const backupShows = _loadCanonicalBackup();
    if (backupShows) {
      setShows(backupShows);
      showToast('Dati corrotti. Ripristinato backup precedente.', 'warning');
      saveData({ immediate: true });
      return;
    }
""",
)
replace_between(
    "src/lib/storage.ts",
    "  if (!parsed || typeof parsed !== 'object') {\n",
    "  // BUG-04-08: pulisci le chiavi ploppytv_corrupted_* forensi dopo un load valido.\n",
    """  const canonical = canonicalizeDataDocument(parsed);
  if (!canonical.ok) {
    const unsupported = canonical.code === 'unsupported-version';
    if (unsupported) {
      console.warn('[PloppyTV] Schema version futura:', canonical.version, '— atteso', SCHEMA_VERSION);
    } else {
      console.warn('[PloppyTV] Documento storage non valido:', canonical.code);
    }

    const backupShows = _loadCanonicalBackup();
    if (backupShows) {
      setShows(backupShows);
      showToast(
        unsupported ? 'Versione dati non supportata. Ripristinato backup.' : 'Dati non validi. Ripristinato backup precedente.',
        'warning',
      );
      saveData({ immediate: true });
      return;
    }

    setShows([]);
    showToast(
      unsupported ? 'Versione dati non supportata. Usa Importa per ripristinare.' : 'Dati non validi. Usa Importa per ripristinare.',
      'error',
    );
    return;
  }

  const sourceVersion = canonical.document.sourceVersion;
  if (sourceVersion === null) {
    console.warn('[PloppyTV] Documento storage senza schema version — normalizzato al formato corrente');
  } else if (sourceVersion < SCHEMA_VERSION) {
    console.warn('[PloppyTV] Schema version passata:', sourceVersion, '— atteso', SCHEMA_VERSION);
  }
  setShows(canonical.document.shows);
""",
)
replace_between(
    "src/lib/storage.ts",
    "      const parsed = JSON.parse(ev.newValue) as SavedData;\n",
    "      // BUG-04-01: se _localDirty=true (modifiche locali non salvate), NON\n",
    """      const parsed = JSON.parse(ev.newValue) as unknown;
      const canonical = canonicalizeDataDocument(parsed);
      if (!canonical.ok) {
        console.warn('[PloppyTV] storage event ignorato:', canonical.code, canonical.version ?? '');
        return;
      }
      const sourceVersion = canonical.document.sourceVersion;
      if (sourceVersion === null) {
        console.warn('[PloppyTV] storage event senza schema version — normalizzato');
      } else if (sourceVersion < SCHEMA_VERSION) {
        console.warn('[PloppyTV] storage event con version passata:', sourceVersion);
      }
      const newShows = canonical.document.shows;
      const newSavedAt = _validSavedAt((parsed as Record<string, unknown>).savedAt);

""",
)

# exportImport.ts: I/O/UI remain here; schema interpretation moves to dataDocument.ts.
replace_once(
    "src/components/exportImport.ts",
    "import type { ExportedData, Show } from '../types';\n",
    "import type { ExportedData } from '../types';\n",
)
replace_once(
    "src/components/exportImport.ts",
    "import { normalizeShow, reconcileAllLists } from '../lib/normalize';\n",
    "import { canonicalizeDataDocument } from '../lib/dataDocument';\n",
)
replace_once("src/components/exportImport.ts", "      let data: ExportedData;\n", "      let data: unknown;\n")
replace_between(
    "src/components/exportImport.ts",
    "        if (!data || typeof data !== 'object') {\n",
    "        // BUG-11-07: grammatica italiana singolare/plurale.\n",
    """        const canonical = canonicalizeDataDocument(data);
        if (!canonical.ok) {
          if (canonical.code === 'unsupported-version') {
            showToast(
              'Backup creato da una versione più recente di PloppyTV — aggiorna l’app prima di importarlo',
              'error',
            );
          } else if (canonical.code === 'invalid-version') {
            showToast('Formato non valido: versione schema non valida', 'error');
          } else if (canonical.code === 'invalid-shows') {
            showToast('Formato non valido: "shows" deve essere un array', 'error');
          } else {
            showToast('Formato non valido: il file deve contenere un oggetto JSON', 'error');
          }
          input.value = '';
          return;
        }

        if (canonical.document.sourceVersion === null) {
          showToast('Backup senza versione schema — importo comunque best-effort', 'warning');
        }

        const dedupedShows = canonical.document.shows;
        const skipped = canonical.document.skippedShows;
        const duplicates = canonical.document.duplicateShows;
        if (dedupedShows.length === 0) {
          showToast('Nessuna serie valida nel file', 'error');
          input.value = '';
          return;
        }
""",
)
replace_once(
    "src/components/exportImport.ts",
    "                    reconcileAllLists(dedupedShows);\n                    setShows(dedupedShows);\n",
    "                    setShows(dedupedShows);\n",
)

# README: keep architecture inventory coherent.
replace_once(
    "README.md",
    "│   ├── normalize.ts       # Validazione + sanitizzazione show\n",
    "│   ├── normalize.ts       # Validazione + sanitizzazione show\n│   ├── dataDocument.ts      # Version gate + canonicalizzazione documenti dati\n",
)

# Existing import contract: malformed version is now rejected consistently with storage.
replace_once(
    "tests/probe_exportimport.test.ts",
    """  it('data.version = "v2" (string, not number) → warning toast about missing schema version', () => {
    const backup = { version: 'v2', shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
    const t = lastToast();
    expect(t).not.toBeNull();
    expect(t!.msg).toContain('senza versione schema');
    expect(t!.type).toBe('warning');
  });

  it('data.version = 1 (current) → no version warning toast', () => {
""",
    """  it('data.version = "v2" (string, not number) → import is rejected consistently with storage', () => {
    const backup = { version: 'v2', shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).not.toBe('Importa backup');
    const t = lastToast();
    expect(t).not.toBeNull();
    expect(t!.msg).toContain('versione schema non valida');
    expect(t!.type).toBe('error');
  });

  it('data.version = 1 (legacy supported) → no version warning toast', () => {
""",
)

Path("tests/probe_dataDocument.test.ts").write_text(
    """import { describe, expect, it } from 'vitest';\n"
    "import { SCHEMA_VERSION } from '../src/lib/constants';\n"
    "import { canonicalizeDataDocument } from '../src/lib/dataDocument';\n\n"
    "function show(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {\n"
    "  return {\n"
    "    id,\n"
    "    name: `Show ${id}`,\n"
    "    image: null,\n"
    "    status: 'Running',\n"
    "    premiered: '2024-01-01',\n"
    "    genres: ['Drama'],\n"
    "    summary: '',\n"
    "    network: 'N/D',\n"
    "    runtime: 45,\n"
    "    list: 'towatch',\n"
    "    manualList: false,\n"
    "    seasons: {},\n"
    "    addedAt: 1700000000000,\n"
    "    ...over,\n"
    "  };\n"
    "}\n\n"
    "describe('canonicalizeDataDocument', () => {\n"
    "  it.each([null, [], 'x', 42])('rejects non-object envelope: %p', (value) => {\n"
    "    expect(canonicalizeDataDocument(value)).toEqual({ ok: false, code: 'invalid-document' });\n"
    "  });\n\n"
    "  it('requires shows to be an array', () => {\n"
    "    expect(canonicalizeDataDocument({ version: SCHEMA_VERSION, shows: null })).toEqual({\n"
    "      ok: false,\n"
    "      code: 'invalid-shows',\n"
    "    });\n"
    "  });\n\n"
    "  it.each(['2', 0, -1, 1.5, NaN, Infinity])('rejects invalid schema version: %p', (version) => {\n"
    "    const result = canonicalizeDataDocument({ version, shows: [] });\n"
    "    expect(result.ok).toBe(false);\n"
    "    if (!result.ok) expect(result.code).toBe('invalid-version');\n"
    "  });\n\n"
    "  it('fails closed on future schema versions', () => {\n"
    "    expect(canonicalizeDataDocument({ version: SCHEMA_VERSION + 1, shows: [] })).toEqual({\n"
    "      ok: false,\n"
    "      code: 'unsupported-version',\n"
    "      version: SCHEMA_VERSION + 1,\n"
    "    });\n"
    "  });\n\n"
    "  it('accepts an unversioned legacy document and emits the current canonical version', () => {\n"
    "    const result = canonicalizeDataDocument({ shows: [show(1)] });\n"
    "    expect(result.ok).toBe(true);\n"
    "    if (!result.ok) return;\n"
    "    expect(result.document.version).toBe(SCHEMA_VERSION);\n"
    "    expect(result.document.sourceVersion).toBeNull();\n"
    "    expect(result.document.shows).toHaveLength(1);\n"
    "  });\n\n"
    "  it('accepts schema v1 and normalizes it to the current model', () => {\n"
    "    const result = canonicalizeDataDocument({ version: 1, shows: [show(1, { tags: undefined })] });\n"
    "    expect(result.ok).toBe(true);\n"
    "    if (!result.ok) return;\n"
    "    expect(result.document.sourceVersion).toBe(1);\n"
    "    expect(result.document.version).toBe(SCHEMA_VERSION);\n"
    "    expect(result.document.shows[0].tags).toEqual([]);\n"
    "  });\n\n"
    "  it('skips invalid shows and reports the count', () => {\n"
    "    const result = canonicalizeDataDocument({ version: SCHEMA_VERSION, shows: [show(1), null, { id: 0 }] });\n"
    "    expect(result.ok).toBe(true);\n"
    "    if (!result.ok) return;\n"
    "    expect(result.document.inputShows).toBe(3);\n"
    "    expect(result.document.skippedShows).toBe(2);\n"
    "    expect(result.document.shows.map((item) => item.id)).toEqual([1]);\n"
    "  });\n\n"
    "  it('deduplicates by id with first-wins semantics', () => {\n"
    "    const result = canonicalizeDataDocument({\n"
    "      version: SCHEMA_VERSION,\n"
    "      shows: [show(1, { name: 'First' }), show(1, { name: 'Second' }), show(2)],\n"
    "    });\n"
    "    expect(result.ok).toBe(true);\n"
    "    if (!result.ok) return;\n"
    "    expect(result.document.duplicateShows).toBe(1);\n"
    "    expect(result.document.shows.map((item) => item.name)).toEqual(['First', 'Show 2']);\n"
    "  });\n\n"
    "  it('reconciles lists as part of canonicalization', () => {\n"
    "    const result = canonicalizeDataDocument({\n"
    "      version: SCHEMA_VERSION,\n"
    "      shows: [\n"
    "        show(1, {\n"
    "          list: 'watching',\n"
    "          seasons: {\n"
    "            1: [{ num: 1, id: 11, watched: true, airdate: '2024-01-01' }],\n"
    "          },\n"
    "        }),\n"
    "      ],\n"
    "    });\n"
    "    expect(result.ok).toBe(true);\n"
    "    if (!result.ok) return;\n"
    "    expect(result.document.shows[0].list).toBe('completed');\n"
    "  });\n"
    "});\n"
    """
)
