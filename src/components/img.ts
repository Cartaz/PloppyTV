// Helper per rendering immagini con fallback

import { escapeHtml, escapeAttr, safeImageUrl } from '../lib/utils';

/**
 * Renderizza un <img> con data-fallback per il delegato globale (imageFallback.ts),
 * oppure un <div> placeholder se src è assente/invalido.
 *
 * BUG-A17-01 (FIXED): valida src con safeImageUrl — rifiuta javascript:, data:,
 * blob: e URL non-http(s). Defense-in-depth: anche se i caller validano già
 * (getPosterUrl/normalize), un dato corrotto importato o un futuro caller
 * che passa un URL non validato non reacherebbe mai <img src="javascript:...">.
 * Prima, imgTag interpolava src raw dopo solo escapeAttr (che non blocca scheme).
 *
 * BUG-A17-02 (FIXED): escapa cls e extraStyle in TUTTI gli attributi (class,
 * data-fallback-cls, style). Prima il placeholder <div> interpolava extraStyle
 * raw nel attributo style → XSS se extraStyle conteneva " (breakout attributo).
 * Anche cls era raw in class e data-fallback-cls.
 */
export function imgTag(src: string | null, alt: string, cls: string, extraStyle = ''): string {
  // BUG-A17-01: valida lo schema URL. safeImageUrl rifiuta javascript:, data:,
  // URL vuoti/lunghi, e non-http(s). Restituisce null → placeholder.
  const safeSrc = typeof src === 'string' ? safeImageUrl(src) : null;
  if (!safeSrc) {
    const placeholderCls = cls.includes('placeholder') ? cls : cls + '-placeholder';
    // BUG-A17-02: extraStyle escaped nel style attribute (prima era raw).
    const styleAttr = extraStyle ? ' style="' + escapeAttr(extraStyle) + '"' : '';
    return '<div class="' + escapeAttr(placeholderCls) + '"' + styleAttr + '>' + escapeHtml(alt || 'N/D') + '</div>';
  }
  // BUG-17-01: extraStyle applicato anche all'<img> inline (non solo al placeholder).
  const styleAttr = extraStyle ? ' style="' + escapeAttr(extraStyle) + '"' : '';
  return (
    '<img class="' +
    escapeAttr(cls) +
    '"' +
    styleAttr +
    ' src="' +
    escapeAttr(safeSrc) +
    '" alt="' +
    escapeAttr(alt || '') +
    '" ' +
    'loading="lazy" decoding="async" data-fallback="' +
    escapeAttr(alt || 'N/D') +
    '" data-fallback-cls="' +
    escapeAttr(cls) +
    '-placeholder" data-fallback-style="' +
    escapeAttr(extraStyle) +
    '">'
  );
}
