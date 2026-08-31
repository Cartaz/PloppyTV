from pathlib import Path

utils = Path('src/lib/utils.ts')
text = utils.read_text()
text = text.replace(
    ''' * Validatore sintattico minimo per URL immagine HTTP(S). Gli URL devono essere
 * già serializzati: whitespace/control characters non codificati vengono
 * rifiutati invece di affidarsi alle normalizzazioni implicite del browser.
 * La policy di origine appartiene a `safeTvmazeImageUrl`.
''',
    ''' * Validatore sintattico minimo per URL immagine HTTP(S). Whitespace ai bordi
 * e caratteri di controllo grezzi vengono rifiutati; gli spazi interni restano
 * parte dell'URL e l'escaping HTML appartiene al renderer. La policy di origine
 * appartiene a `safeTvmazeImageUrl`.
''',
    1,
)
old = '''  if (/\\s/.test(u)) return null;
'''
new = '''  if (u !== u.trim()) return null;
  for (let i = 0; i < u.length; i++) {
    const code = u.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
'''
if old not in text:
    raise SystemExit('generated safeImageUrl guard not found')
utils.write_text(text.replace(old, new, 1))

edge = Path('tests/utils.edgecases.test.ts')
tests = edge.read_text()
old_test = '''  it('safeImageUrl enforces exact size and rejects raw whitespace/control characters', () => {
    const prefix = 'https://x/';
    const max = prefix + 'a'.repeat(2048 - prefix.length);
    expect(safeImageUrl(max)).toBe(max);
    expect(safeImageUrl(max + 'a')).toBeNull();
    for (const value of ['https://x/a b.jpg', 'https://x/a.jpg\\n', ' https://x/a.jpg', 'https://x/a.jpg\\t']) {
      expect(safeImageUrl(value)).toBeNull();
    }
  });
'''
new_test = '''  it('safeImageUrl enforces exact size and rejects edge whitespace/control characters', () => {
    const prefix = 'https://x/';
    const max = prefix + 'a'.repeat(2048 - prefix.length);
    expect(safeImageUrl(max)).toBe(max);
    expect(safeImageUrl(max + 'a')).toBeNull();
    expect(safeImageUrl('https://x/a b.jpg')).toBe('https://x/a b.jpg');
    for (const value of ['https://x/a.jpg\\n', ' https://x/a.jpg', 'https://x/a.jpg ', 'https://x/a.jpg\\t']) {
      expect(safeImageUrl(value)).toBeNull();
    }
  });
'''
if old_test not in tests:
    raise SystemExit('generated safeImageUrl test not found')
edge.write_text(tests.replace(old_test, new_test, 1))
