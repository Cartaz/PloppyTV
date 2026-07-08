// Helper per rendering immagini con fallback

import { escapeHtml, escapeAttr } from '../lib/utils';

export function imgTag(src: string | null, alt: string, cls: string, extraStyle = ''): string {
  if (!src) {
    const placeholderCls = cls.includes('placeholder') ? cls : cls + '-placeholder';
    return '<div class="' + placeholderCls + '" style="' + extraStyle + '">' + escapeHtml(alt || 'N/D') + '</div>';
  }
  // Costruisci un fallback data-attribute per il delegato globale (vedi imageFallback.ts)
  return (
    '<img class="' +
    cls +
    '" src="' +
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
