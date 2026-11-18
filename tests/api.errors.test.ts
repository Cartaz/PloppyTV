import { describe, it, expect } from 'vitest';
import { ApiError, apiErrorMessage } from '../src/lib/api';

describe('apiErrorMessage', () => {
  it.each([
    [
      'TimeoutError',
      undefined,
      'Ricerca timeout. Verifica la connessione.',
      'Timeout caricamento. Riprova.',
      'Timeout aggiornamento. Riprova.',
    ],
    [
      'NetworkError',
      undefined,
      'Connessione internet non disponibile.',
      'Connessione internet non disponibile',
      'Connessione internet non disponibile',
    ],
    [
      'RateLimitError',
      429,
      'Troppe ricerche. Attendi qualche secondo.',
      'Troppe richieste. Attendi qualche secondo.',
      'Troppe richieste. Attendi qualche secondo.',
    ],
    ['ApiError', 404, 'Errore nella ricerca. Riprova.', 'Serie non trovata', 'Serie non trovata su TVMaze'],
    [
      'ParseError',
      undefined,
      'Risposta API non valida. Riprova.',
      'Errore caricamento serie',
      'Errore aggiornamento serie',
    ],
    ['ApiError', 500, 'Errore nella ricerca. Riprova.', 'Errore caricamento serie', 'Errore aggiornamento serie'],
  ])('%s %s', (name, status, search, load, refresh) => {
    const err = new ApiError('x', name, status);
    expect(apiErrorMessage(err, 'search')).toBe(search);
    expect(apiErrorMessage(err, 'load')).toBe(load);
    expect(apiErrorMessage(err, 'refresh')).toBe(refresh);
  });

  it('falls back for non-API errors', () => {
    expect(apiErrorMessage(null, 'load')).toBe('Errore caricamento serie');
    expect(apiErrorMessage(new TypeError('boom'), 'search')).toBe('Errore nella ricerca. Riprova.');
  });
});
