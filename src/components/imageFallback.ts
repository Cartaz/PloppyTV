// Delegato globale per fallback immagini: evita centinaia di handler inline onerror

let _initialized = false;
let _errorHandler: ((e: Event) => void) | null = null;

/**
 * Inizializza il delegato globale per gli errori di caricamento <img>.
 * Idempotente: chiamate multiple non aggiungono listener duplicati.
 *
 * BUG-A17-03 (FIXED): loop infinito con fallbackSrc relativo. Prima il guard
 * era `target.src !== fallbackSrc`, ma `target.src` restituisce l'URL assoluto
 * risolto (es. `http://localhost/img.jpg`) mentre `fallbackSrc` è il valore raw
 * dell'attributo (es. `/img.jpg`). Con URL relativi, i due valori differiscono
 * SEMPRE, anche dopo l'assegnamento → l'error event re-fireva all'infinito.
 * Ora si usa un flag `data-fallback-src-tried` per tracciare il tentativo.
 */
export function initImageFallback(): void {
  if (_initialized) return;
  _initialized = true;
  _errorHandler = (e: Event) => {
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLImageElement)) return;
    if (!target.dataset.fallback) return;
    if (target.dataset.fallbackApplied) return;

    // 1) Se c'è un data-fallback-src (catena immagini), prova prima quello.
    //    Marca applied solo quando passiamo al placeholder definitivo, per
    //    permettere all'immagine di fallback di caricare normalmente.
    //    BUG-A17-03: usa flag invece di confronto stringa (vedi JSDoc).
    const fallbackSrc = target.dataset.fallbackSrc;
    if (fallbackSrc && !target.dataset.fallbackSrcTried) {
      target.dataset.fallbackSrcTried = '1';
      target.src = fallbackSrc;
      return;
    }

    // 2) Tutti i tentativi falliti: sostituisci con placeholder testuale
    target.dataset.fallbackApplied = '1';

    const fallbackName = target.dataset.fallback || 'N/D';
    // BUG-20-09: dead branch removed — only data-fallbackCls is read now.
    const cls = target.dataset.fallbackCls || 'img-placeholder';
    const style = target.dataset.fallbackStyle || '';
    const placeholder = document.createElement('div');
    placeholder.className = cls;
    if (style) placeholder.setAttribute('style', style);
    placeholder.textContent = fallbackName;
    if (target.parentNode) target.parentNode.replaceChild(placeholder, target);
  };
  document.addEventListener('error', _errorHandler, true); // capture phase
}

/**
 * Rimuove il listener globale e resetta lo stato. Utile per test e HMR.
 * BUG-A17-04 (FIXED): prima non esisteva destroy — il listener su `document`
 * non veniva mai rimosso, causando leak nei test con vi.resetModules() (ogni
 * nuovo modulo aggiungeva un listener senza rimuovere il precedente).
 */
export function destroyImageFallback(): void {
  if (!_initialized || !_errorHandler) return;
  document.removeEventListener('error', _errorHandler, true);
  _errorHandler = null;
  _initialized = false;
}
