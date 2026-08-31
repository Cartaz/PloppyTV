from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    src = p.read_text()
    if src.count(old) != 1:
        raise SystemExit(f"{path}: expected anchor exactly once: {old[:120]!r}")
    p.write_text(src.replace(old, new, 1))


replace_once(
    "src/components/exportImport.ts",
    "//  - BUG-11-02: validazione `data.version` (warning toast su mancante/non-numero/futuro).\n",
    "//  - BUG-11-02: policy schema condivisa; legacy senza versione ammesso, versioni invalide/future rifiutate.\n",
)
replace_once(
    "src/components/exportImport.ts",
    "import { SCHEMA_VERSION } from '../lib/constants';\n",
    "import { SCHEMA_VERSION, MAX_IMPORT_SIZE } from '../lib/constants';\n",
)
replace_once("src/components/exportImport.ts", "import { MAX_IMPORT_SIZE } from '../lib/constants';\n", "")
replace_once("src/components/exportImport.ts", "        data = JSON.parse(text) as ExportedData;\n", "        data = JSON.parse(text);\n")
replace_once("src/lib/storage.ts", "    parsed = JSON.parse(raw) as SavedData;\n", "    parsed = JSON.parse(raw);\n")

# _revisionFromRaw reads untrusted JSON too. Preserve only the CAS metadata it owns;
# do not pretend the whole document already satisfies SavedData before validation.
replace_once(
    "src/lib/storage.ts",
    """    const parsed = JSON.parse(raw) as SavedData;
    return { present: true, savedAt: _validSavedAt(parsed?.savedAt) };
""",
    """    const parsed: unknown = JSON.parse(raw);
    const savedAt =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).savedAt
        : undefined;
    return { present: true, savedAt: _validSavedAt(savedAt) };
""",
)
