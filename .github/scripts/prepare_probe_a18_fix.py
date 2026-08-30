from pathlib import Path
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else 'tests/probe_a18.test.ts')
src = path.read_text()
marker = "// =====================================================================\n// index.html — BUG-A18-09/10 + structure\n// =====================================================================\n"
if src.count(marker) != 1:
    raise SystemExit('index.html probe marker not found exactly once')

replacement = r"""// =====================================================================
// index.html — BUG-A18-09/10 + structure
// =====================================================================
describe('index.html — BUG-A18-09/10 + structure', () => {
  const indexDoc = new DOMParser().parseFromString(indexSrc, 'text/html');

  function meta(name: string): HTMLMetaElement | null {
    return indexDoc.querySelector(`meta[name="${name}"]`);
  }

  function link(rel: string, href: string): HTMLLinkElement | undefined {
    return [...indexDoc.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]`)].find(
      (element) => element.getAttribute('href') === href,
    );
  }

  // Keep source-order assertions only where order is itself part of the contract.
  it('BUG-A18-09: has <noscript> fallback with Italian JavaScript message', () => {
    expect(indexSrc).toContain('<noscript>');
    expect(indexSrc).toContain('</noscript>');
    expect(indexSrc).toContain('JavaScript');
    expect(indexSrc).toContain('ricarica');
  });

  it('BUG-A18-09: noscript is inside <body> before .app div', () => {
    const bodyIdx = indexSrc.indexOf('<body>');
    const noscriptIdx = indexSrc.indexOf('<noscript>');
    const appIdx = indexSrc.indexOf('<div class="app">');
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(noscriptIdx).toBeGreaterThan(bodyIdx);
    expect(appIdx).toBeGreaterThan(noscriptIdx);
  });

  it('BUG-A18-10: has dark-mode theme-color meta with #0f0f14', () => {
    const darkTheme = [...indexDoc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].find(
      (element) => element.getAttribute('media') === '(prefers-color-scheme: dark)',
    );
    expect(darkTheme?.content).toBe('#0f0f14');
  });

  it('has default (light) theme-color #ff6b35', () => {
    const defaultTheme = [...indexDoc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].find(
      (element) => !element.hasAttribute('media'),
    );
    expect(defaultTheme?.content).toBe('#ff6b35');
  });

  it('has exactly two theme-color meta tags (light + dark)', () => {
    expect(indexDoc.querySelectorAll('meta[name="theme-color"]')).toHaveLength(2);
  });

  it('has lang="it" on <html>', () => {
    expect(indexDoc.documentElement.lang).toBe('it');
  });

  it('has charset UTF-8', () => {
    expect(indexDoc.querySelector('meta[charset]')?.getAttribute('charset')?.toUpperCase()).toBe('UTF-8');
  });

  it('has viewport meta with viewport-fit=cover', () => {
    expect(meta('viewport')?.content).toContain('viewport-fit=cover');
  });

  it('has description meta', () => {
    expect(meta('description')?.content).toContain('PloppyTV');
  });

  it('has manifest link', () => {
    expect(link('manifest', 'manifest.webmanifest')).toBeDefined();
  });

  it('has preconnect to api.tvmaze.com with crossorigin', () => {
    expect(link('preconnect', 'https://api.tvmaze.com')?.hasAttribute('crossorigin')).toBe(true);
  });

  it('has preconnect to static.tvmaze.com with crossorigin', () => {
    expect(link('preconnect', 'https://static.tvmaze.com')?.hasAttribute('crossorigin')).toBe(true);
  });

  it('has dns-prefetch for both TVMaze hosts', () => {
    expect(link('dns-prefetch', 'https://api.tvmaze.com')).toBeDefined();
    expect(link('dns-prefetch', 'https://static.tvmaze.com')).toBeDefined();
  });

  it('has module script pointing to /src/main.ts', () => {
    const script = [...indexDoc.querySelectorAll<HTMLScriptElement>('script')].find(
      (element) => element.getAttribute('src') === '/src/main.ts',
    );
    expect(script?.type).toBe('module');
  });

  it('has apple-mobile-web-app-capable', () => {
    expect(meta('apple-mobile-web-app-capable')?.content).toBe('yes');
  });

  it('has mobile-web-app-capable', () => {
    expect(meta('mobile-web-app-capable')?.content).toBe('yes');
  });

  it('has color-scheme meta with dark light', () => {
    expect(meta('color-scheme')?.content).toBe('dark light');
  });

  it('has format-detection telephone=no', () => {
    expect(meta('format-detection')?.content).toBe('telephone=no');
  });

  it('title contains PloppyTV', () => {
    expect(indexDoc.title).toContain('PloppyTV');
  });

  it('has apple-touch-icon link', () => {
    expect(link('apple-touch-icon', 'icons/apple-touch-icon.png')).toBeDefined();
  });

  it('has SVG favicon', () => {
    expect(link('icon', 'icons/icon.svg')?.type).toBe('image/svg+xml');
  });

  it('has main content container #mainContent', () => {
    expect(indexDoc.getElementById('mainContent')).not.toBeNull();
  });

  it('has toast container #toast', () => {
    expect(indexDoc.getElementById('toast')).not.toBeNull();
  });

  it('has modal overlay with aria-modal', () => {
    expect(indexDoc.querySelector('[aria-modal="true"]')).not.toBeNull();
  });

  it('XSS check: static module scripts do not use user-controlled sources', () => {
    const scripts = [...indexDoc.querySelectorAll<HTMLScriptElement>('script')];
    for (const script of scripts) {
      expect(script.getAttribute('src')).toBe('/src/main.ts');
    }
  });
});
"""

path.write_text(src.split(marker, 1)[0] + replacement)
