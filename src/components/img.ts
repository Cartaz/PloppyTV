// Helper per rendering immagini con fallback

import { escapeHtml, escapeAttr, safeImageUrl } from '../lib/utils';

/**
 * Renderizza un <img> con data-fallback per il delegato globale (imageFallback.ts),
 * oppure un <div> placeholder se src è assente/invalido.
 */
export function imgTag(src: string | null, alt: string, cls: string, extraStyle = ''): string {
  // Valida lo schema URL. safeImageUrl rifiuta javascript:, data:,
  // URL vuoti/lunghi, e non-http(s). Restituisce null → placeholder.
  const safeSrc = typeof src === 'string' ? safeImageUrl(src) : null;
  if (!safeSrc) {
    const placeholderCls = cls.includes('placeholder') ? cls : cls + '-placeholder';
    // extraStyle escaped nel style attribute (prima era raw).
    const styleAttr = extraStyle ? ' style="' + escapeAttr(extraStyle) + '"' : '';
    return '<div class="' + escapeAttr(placeholderCls) + '"' + styleAttr + '>' + escapeHtml(alt || 'N/D') + '</div>';
  }
  // extraStyle applicato anche all'<img> inline (non solo al placeholder).
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
