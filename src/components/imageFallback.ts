// Delegato globale per fallback immagini: evita centinaia di handler inline onerror

let _initialized = false;

export function initImageFallback(): void {
  if (_initialized) return;
  _initialized = true;
  document.addEventListener(
    'error',
    (e) => {
      const target = e.target as HTMLElement;
      if (!(target instanceof HTMLImageElement)) return;
      if (!target.dataset.fallback) return;
      if (target.dataset.fallbackApplied) return;

      // 1) Se c'è un data-fallback-src (catena immagini), prova prima quello.
      //    Marca applied solo quando passiamo al placeholder definitivo, per
      //    permettere all'immagine di fallback di caricare normalmente.
      const fallbackSrc = target.dataset.fallbackSrc;
      if (fallbackSrc && target.src !== fallbackSrc) {
        target.src = fallbackSrc;
        return;
      }

      // 2) Tutti i tentativi falliti: sostituisci con placeholder testuale
      target.dataset.fallbackApplied = '1';

      const fallbackName = target.dataset.fallback || 'N/D';
      const cls = target.dataset.fallbackFallbackCls || target.dataset.fallbackCls || 'img-placeholder';
      const style = target.dataset.fallbackStyle || '';
      const placeholder = document.createElement('div');
      placeholder.className = cls;
      if (style) placeholder.setAttribute('style', style);
      placeholder.textContent = fallbackName;
      if (target.parentNode) target.parentNode.replaceChild(placeholder, target);
    },
    true,
  ); // capture phase per catturare errori sintetici
}
