// Helper per rendering immagini con fallback

import { escapeHtml, escapeAttr } from '../lib/utils';

export function imgTag(src: string | null, alt: string, cls: string, extraStyle = ''): string {
  if (!src) {
    const placeholderCls = cls.includes('placeholder') ? cls : cls + '-placeholder';
    return '<div class="' + placeholderCls + '" style="' + extraStyle + '">' + escapeHtml(alt || 'N/D') + '</div>';
  }
  // Costruisci un fallback data-attribute per il delegato globale (vedi imageFallback.ts)
  // BUG-17-01: extraStyle applicato anche all'<img> inline (non solo al placeholder).
  const styleAttr = extraStyle ? ' style="' + escapeAttr(extraStyle) + '"' : '';
  return (
    '<img class="' +
    cls +
    '"' +
    styleAttr +
    ' src="' +
    escapeAttr(src) +
    '" alt="' +
    escapeAttr(alt || '') +
    '" ' +
    'loading="lazy" decoding="async" data-fallback="' +
    escapeAttr(alt || 'N/D') +
    '" data-fallback-cls="' +
    cls +
    '-placeholder" data-fallback-style="' +
    escapeAttr(extraStyle) +
    '">'
  );
}
