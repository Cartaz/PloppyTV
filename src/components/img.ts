// Helper per rendering immagini con fallback

import { escapeHtml, escapeAttr } from '../lib/utils';

/**
 * Genera il markup per un'immagine con fallback automatico.
 *
 * - Se `src` è null/empty, renderizza un placeholder `<div>` con la classe
 *   `<cls>-placeholder` (o `cls` se già contiene "placeholder"), applicando
 *   `extraStyle` inline.
 * - Altrimenti renderizza un `<img>` con loading="lazy" decoding="async".
 *   L'attributo `data-fallback-*` è letto da `imageFallback.ts` quando
 *   l'immagine fallisce (evento `error` delegato globalmente) per sostituire
 *   l'<img> con il placeholder.
 *
 * BUG-17-01 (Medium): `extraStyle` viene ora applicato anche al `<img>` vivo
 * (non solo al placeholder). In precedenza stats.ts passava
 * `'width:40px;height:60px;object-fit:cover;...'` aspettandosi che l'<img>
 * fosse vincolato a 40×60, ma lo style finiva solo in `data-fallback-style`
 * (consumato solo DOPO un errore di caricamento). Con la fix, l'<img> tiene
 * lo stile inline, e `data-fallback-style` conserva lo stesso valore per
 * applicarlo al placeholder in caso di fallback. La fix è backward-compatible:
 * i call site esistenti che passano `extraStyle=''` (default) sono indifferenti.
 */
export function imgTag(src: string | null, alt: string, cls: string, extraStyle = ''): string {
  if (!src) {
    const placeholderCls = cls.includes('placeholder') ? cls : cls + '-placeholder';
    return '<div class="' + placeholderCls + '" style="' + extraStyle + '">' + escapeHtml(alt || 'N/D') + '</div>';
  }
  // Costruisci un fallback data-attribute per il delegato globale (vedi imageFallback.ts)
  const inlineStyle = extraStyle ? ' style="' + escapeAttr(extraStyle) + '"' : '';
  return (
    '<img class="' +
    cls +
    '" src="' +
    escapeAttr(src) +
    '" alt="' +
    escapeAttr(alt || '') +
    '"' +
    inlineStyle +
    ' loading="lazy" decoding="async" data-fallback="' +
    escapeAttr(alt || 'N/D') +
    '" data-fallback-cls="' +
    cls +
    '-placeholder" data-fallback-style="' +
    escapeAttr(extraStyle) +
    '">'
  );
}
