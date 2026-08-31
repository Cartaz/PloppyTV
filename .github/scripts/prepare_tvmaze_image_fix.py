from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    src = p.read_text()
    if src.count(old) != 1:
        raise SystemExit(f"{path}: expected anchor exactly once")
    p.write_text(src.replace(old, new, 1))


replace_once(
    "src/lib/utils.ts",
    """export function safeImageUrl(u: unknown): string | null {\n  if (typeof u !== 'string') return null;\n  if (u.length === 0 || u.length > 2048) return null;\n  if (u.startsWith('data:')) return null;\n  // Richiede http(s):// seguito da almeno un carattere che non sia spazio o slash.\n  if (!/^https?:\\/\\/[^\\s/]/i.test(u)) return null;\n  return u;\n}\n""",
    """export function safeImageUrl(u: unknown): string | null {\n  if (typeof u !== 'string') return null;\n  if (u.length === 0 || u.length > 2048) return null;\n  if (u.startsWith('data:')) return null;\n  // Richiede http(s):// seguito da almeno un carattere che non sia spazio o slash.\n  if (!/^https?:\\/\\/[^\\s/]/i.test(u)) return null;\n  return u;\n}\n\nconst TVMAZE_IMAGE_ORIGIN = 'https://static.tvmaze.com';\n\n/**\n * Trust boundary per le immagini persistite da PloppyTV. Il prodotto non\n * supporta URL immagine custom: i poster legittimi arrivano dal CDN TVMaze.\n * Manteniamo `safeImageUrl` come validatore sintattico generico per il layer\n * di rendering, mentre qui imponiamo l'origine HTTPS prevista ai dati di dominio.\n */\nexport function safeTvmazeImageUrl(u: unknown): string | null {\n  const safe = safeImageUrl(u);\n  if (!safe) return null;\n  try {\n    if (new URL(safe).origin !== TVMAZE_IMAGE_ORIGIN) return null;\n    return safe;\n  } catch {\n    return null;\n  }\n}\n""",
)

replace_once(
    "src/lib/utils.ts",
    """    const u = safeImageUrl(show.image.medium);\n""",
    """    const u = safeTvmazeImageUrl(show.image.medium);\n""",
)
replace_once(
    "src/lib/utils.ts",
    """    const u = safeImageUrl(show.image.original);\n""",
    """    const u = safeTvmazeImageUrl(show.image.original);\n""",
)
replace_once(
    "src/lib/utils.ts",
    """ * BUG-01-d (FIXED): getPosterUrl ora valida gli URL tramite safeImageUrl,\n * quindi `javascript:` e `data:` vengono filtrati → null.\n""",
    """ * I poster di dominio sono accettati solo dall'origine HTTPS del CDN TVMaze.\n * Schemi pericolosi e origini esterne vengono neutralizzati a null.\n""",
)

replace_once(
    "src/lib/normalize.ts",
    """import { safeId, safeImageUrl, safeNum, stripHtml, getPosterUrl, getWatchedCount, parseISODateLocal } from './utils';\n""",
    """import { safeId, safeTvmazeImageUrl, safeNum, stripHtml, getPosterUrl, getWatchedCount, parseISODateLocal } from './utils';\n""",
)
replace_once(
    "src/lib/normalize.ts",
    """  const image = safeImageUrl(r.image);\n""",
    """  const image = safeTvmazeImageUrl(r.image);\n""",
)
replace_once(
    "src/lib/normalize.ts",
    """    image: safeImageUrl(getPosterUrl(tvmazeShow)),\n""",
    """    image: getPosterUrl(tvmazeShow),\n""",
)

replace_once(
    "tests/utils.test.ts",
    """  safeImageUrl,\n""",
    """  safeImageUrl,\n  safeTvmazeImageUrl,\n""",
)
replace_once(
    "tests/utils.test.ts",
    """describe('stripHtml', () => {\n""",
    """describe('safeTvmazeImageUrl', () => {\n  it('accetta solo immagini HTTPS dall origine CDN TVMaze', () => {\n    expect(safeTvmazeImageUrl('https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg')).toBe(\n      'https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg',\n    );\n  });\n\n  it('rifiuta origini esterne, host-lookalike, HTTP e porte non standard', () => {\n    expect(safeTvmazeImageUrl('https://attacker.example/tracker.png')).toBeNull();\n    expect(safeTvmazeImageUrl('https://static.tvmaze.com.evil.example/tracker.png')).toBeNull();\n    expect(safeTvmazeImageUrl('http://static.tvmaze.com/uploads/p.jpg')).toBeNull();\n    expect(safeTvmazeImageUrl('https://static.tvmaze.com:444/uploads/p.jpg')).toBeNull();\n  });\n});\n\ndescribe('stripHtml', () => {\n""",
)
replace_once(
    "tests/utils.test.ts",
    """    expect(getPosterUrl({ image: { medium: 'https://x/m.jpg', original: 'https://x/o.jpg' } })).toBe('https://x/m.jpg');\n    expect(getPosterUrl({ image: { original: 'https://x/o.jpg' } })).toBe('https://x/o.jpg');\n""",
    """    expect(\n      getPosterUrl({\n        image: {\n          medium: 'https://static.tvmaze.com/uploads/m.jpg',\n          original: 'https://static.tvmaze.com/uploads/o.jpg',\n        },\n      }),\n    ).toBe('https://static.tvmaze.com/uploads/m.jpg');\n    expect(getPosterUrl({ image: { original: 'https://static.tvmaze.com/uploads/o.jpg' } })).toBe(\n      'https://static.tvmaze.com/uploads/o.jpg',\n    );\n    expect(getPosterUrl({ image: { medium: 'https://attacker.example/pixel.png' } })).toBeNull();\n""",
)

replace_once(
    "tests/normalize.test.ts",
    """  it('rifiuta image data URL/javascript e conserva URL validi', () => {\n    expect(normalizeShow({ id: 1, image: 'https://x.com/p.jpg' })!.image).toBe('https://x.com/p.jpg');\n    expect(normalizeShow({ id: 1, image: 'data:image/png;base64,xxx' })!.image).toBeNull();\n    expect(normalizeShow({ id: 1, image: 'javascript:alert(1)' })!.image).toBeNull();\n  });\n""",
    """  it('accetta solo immagini dal CDN TVMaze e neutralizza origini importate', () => {\n    expect(normalizeShow({ id: 1, image: 'https://static.tvmaze.com/uploads/p.jpg' })!.image).toBe(\n      'https://static.tvmaze.com/uploads/p.jpg',\n    );\n    expect(normalizeShow({ id: 1, image: 'https://attacker.example/unique-id.png' })!.image).toBeNull();\n    expect(normalizeShow({ id: 1, image: 'https://static.tvmaze.com.evil.example/p.jpg' })!.image).toBeNull();\n    expect(normalizeShow({ id: 1, image: 'https://static.tvmaze.com:444/p.jpg' })!.image).toBeNull();\n    expect(normalizeShow({ id: 1, image: 'data:image/png;base64,xxx' })!.image).toBeNull();\n    expect(normalizeShow({ id: 1, image: 'javascript:alert(1)' })!.image).toBeNull();\n  });\n""",
)
replace_once(
    "tests/normalize.test.ts",
    """    image: { medium: 'https://img.tvmaze.com/m.jpg', original: 'https://img.tvmaze.com/o.jpg' },\n""",
    """    image: {\n      medium: 'https://static.tvmaze.com/uploads/m.jpg',\n      original: 'https://static.tvmaze.com/uploads/o.jpg',\n    },\n""",
)
replace_once(
    "tests/normalize.test.ts",
    """    expect(show.image).toBe('https://img.tvmaze.com/m.jpg'); // preferisce medium\n""",
    """    expect(show.image).toBe('https://static.tvmaze.com/uploads/m.jpg'); // preferisce medium\n""",
)

replace_once(
    "tests/probe_a12.test.ts",
    """    image: { medium: 'http://x/' + id + '.jpg' },\n""",
    """    image: { medium: 'https://static.tvmaze.com/uploads/' + id + '.jpg' },\n""",
)

replace_once(
    "tests/probe_search.test.ts",
    """  it('BUG-20-03: valid https: poster URL is preserved', async () => {\n    const ok = makeResult(1, 'Good') as any;\n    ok.show.image = { medium: 'https://example.com/poster.jpg', original: null };\n""",
    """  it('BUG-20-03: valid TVMaze HTTPS poster URL is preserved', async () => {\n    const ok = makeResult(1, 'Good') as any;\n    ok.show.image = { medium: 'https://static.tvmaze.com/uploads/poster.jpg', original: null };\n""",
)
replace_once(
    "tests/probe_search.test.ts",
    """    expect((imgs[0] as HTMLImageElement).getAttribute('src')).toBe('https://example.com/poster.jpg');\n""",
    """    expect((imgs[0] as HTMLImageElement).getAttribute('src')).toBe(\n      'https://static.tvmaze.com/uploads/poster.jpg',\n    );\n""",
)

replace_once(
    "tests/probe_utils.test.ts",
    """  it('image {medium:null, original:\"http://x\"} -> \"http://x\"', () => {\n    // BUG-01-d fixed: getPosterUrl now validates via safeImageUrl; use valid URL.\n    expect(getPosterUrl({ image: { medium: null, original: 'http://x' } as any })).toBe('http://x');\n  });\n\n  it('image {medium:\"\", original:\"http://y\"} -> \"http://y\" (empty string falls back)', () => {\n    // BUG-01-d fixed: getPosterUrl validates; use valid URL for original.\n    expect(getPosterUrl({ image: { medium: '', original: 'http://y' } })).toBe('http://y');\n  });\n\n  it('image {medium:\"http://x\", original:null} -> \"http://x\"', () => {\n    expect(getPosterUrl({ image: { medium: 'http://x', original: null } as any })).toBe('http://x');\n  });\n""",
    """  it('falls back from null medium to a valid TVMaze original', () => {\n    expect(\n      getPosterUrl({\n        image: { medium: null, original: 'https://static.tvmaze.com/uploads/original.jpg' } as any,\n      }),\n    ).toBe('https://static.tvmaze.com/uploads/original.jpg');\n  });\n\n  it('falls back from empty medium to a valid TVMaze original', () => {\n    expect(\n      getPosterUrl({ image: { medium: '', original: 'https://static.tvmaze.com/uploads/original.jpg' } }),\n    ).toBe('https://static.tvmaze.com/uploads/original.jpg');\n  });\n\n  it('preserves a valid TVMaze medium poster', () => {\n    expect(\n      getPosterUrl({ image: { medium: 'https://static.tvmaze.com/uploads/medium.jpg', original: null } as any }),\n    ).toBe('https://static.tvmaze.com/uploads/medium.jpg');\n  });\n\n  it('rejects an otherwise valid external HTTPS poster host', () => {\n    expect(getPosterUrl({ image: { medium: 'https://attacker.example/pixel.png', original: null } as any })).toBeNull();\n  });\n""",
)
