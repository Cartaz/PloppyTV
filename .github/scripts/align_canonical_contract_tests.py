from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    src = p.read_text()
    if src.count(old) != 1:
        raise SystemExit(f"{path}: expected anchor exactly once: {old[:120]!r}")
    p.write_text(src.replace(old, new, 1))


replace_once(
    "src/lib/storage.ts",
    """      if (!canonical.ok) {
        console.warn('[PloppyTV] storage event ignorato:', canonical.code, canonical.version ?? '');
        return;
      }
""",
    """      if (!canonical.ok) {
        if (canonical.code === 'unsupported-version') {
          console.warn('[PloppyTV] storage event con version futura:', canonical.version);
        } else {
          console.warn('[PloppyTV] storage event ignorato:', canonical.code, canonical.version ?? '');
        }
        return;
      }
""",
)

replace_once(
    "tests/probe_a16.test.ts",
    """  it('import with version = 0 → no version warning (0 is finite, < SCHEMA_VERSION)', () => {
    const backup = { version: 0, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
    const versionToasts = showToastMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('versione'),
    );
    expect(versionToasts.length).toBe(0);
  });

  it('import with version = -1 → no version warning (negative is finite, < SCHEMA_VERSION)', () => {
    const backup = { version: -1, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
  });
""",
    """  it('import with version = 0 → rejected as an invalid schema version', () => {
    const backup = { version: 0, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('');
    expect(lastToast()?.msg).toContain('versione schema non valida');
    expect(lastToast()?.type).toBe('error');
  });

  it('import with version = -1 → rejected as an invalid schema version', () => {
    const backup = { version: -1, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('');
    expect(lastToast()?.msg).toContain('versione schema non valida');
    expect(lastToast()?.type).toBe('error');
  });
""",
)

replace_once(
    "tests/probe_exportimport.test.ts",
    """  it('data is an array (typeof object, but data.shows undefined) → shows not array', () => {
    setFile(makeFile('[1,2,3]'));
    expect(lastToast()?.msg).toContain('"shows" deve essere un array');
    expect(lastToast()?.msg).toContain('era undefined');
  });

  it('data.shows is null → "shows deve essere un array (era null)"', () => {
    setFile(makeFile('{"version":1,"shows":null}'));
    expect(lastToast()?.msg).toContain('"shows" deve essere un array');
    expect(lastToast()?.msg).toContain('era null');
  });

  it('data.shows is an object → "shows deve essere un array (era object)"', () => {
    setFile(makeFile('{"version":1,"shows":{"a":1}}'));
    expect(lastToast()?.msg).toContain('"shows" deve essere un array');
    expect(lastToast()?.msg).toContain('era object');
  });
""",
    """  it('data is an array → rejected because the document envelope must be an object', () => {
    setFile(makeFile('[1,2,3]'));
    expect(lastToast()?.msg).toBe('Formato non valido: il file deve contenere un oggetto JSON');
  });

  it('data.shows is null → rejected by the shared shows-array contract', () => {
    setFile(makeFile('{"version":1,"shows":null}'));
    expect(lastToast()?.msg).toBe('Formato non valido: "shows" deve essere un array');
  });

  it('data.shows is an object → rejected by the shared shows-array contract', () => {
    setFile(makeFile('{"version":1,"shows":{"a":1}}'));
    expect(lastToast()?.msg).toBe('Formato non valido: "shows" deve essere un array');
  });
""",
)
