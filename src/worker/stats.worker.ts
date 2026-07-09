// Web Worker: calcolo statistiche + calendario off-main-thread
//
// BUG-08-03 (FIXED): le funzioni pure di calcolo sono state spostate in
// `./compute.ts` (single source of truth) per evitare drift tra worker e
// fallback main-thread.
//
// BUG-A9-10 (FIXED): guard esplicita per messaggi non-object (null,
// undefined, stringhe, primitive). Prima, un messaggio null/undefined
// lanciava TypeError su `msg.type` dentro il try/catch, producendo un
// errore cryptic ("Cannot read properties of null (reading 'type')").
// Ora viene emessa una error response pulita con id=-1 e messaggio
// descrittivo, senza affidarsi sul try/catch per control flow.

import type { WorkerRequest, WorkerResponse } from '../types';
import { computeStats, computeCalendar } from './compute';

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  // BUG-A9-10: guard contro messaggi non-object. Un worker può ricevere
  // qualsiasi valore serializzabile via postMessage; se il sender (o un
  // mock nei test) passa null/undefined/string, `msg.type` lancerebbe
  // TypeError. Il try/catch sotto lo catturava, ma con un messaggio
  // cryptic. Ora rispondiamo con un error pulito.
  if (!msg || typeof msg !== 'object') {
    const response: WorkerResponse = {
      type: 'error',
      id: -1,
      message: 'Invalid worker message (expected object, got ' + typeof msg + ')',
    };
    (self as unknown as Worker).postMessage(response);
    return;
  }
  try {
    if (msg.type === 'stats') {
      const result = computeStats(msg.shows);
      const response: WorkerResponse = { type: 'stats', id: msg.id, result };
      (self as unknown as Worker).postMessage(response);
    } else if (msg.type === 'calendar') {
      // computeCalendar applica internamente safeWeekOffset (BUG-16-03):
      // NaN/Infinity → 0, non-interi → floor. Nessun Invalid Date possibile.
      const { week, afterWeek, weekStart, weekEnd } = computeCalendar(msg.shows, msg.weekOffset);
      const response: WorkerResponse = { type: 'calendar', id: msg.id, result: week, weekStart, weekEnd, afterWeek };
      (self as unknown as Worker).postMessage(response);
    } else {
      // Messaggio malformato: rispondi con error invece di restare silente
      const response: WorkerResponse = {
        type: 'error',
        id: (msg as { id?: number })?.id ?? -1,
        message: 'Unknown message type: ' + String((msg as { type?: string })?.type),
      };
      (self as unknown as Worker).postMessage(response);
    }
  } catch (e) {
    console.error('[worker] error:', e);
    const response: WorkerResponse = {
      type: 'error',
      id: (msg as { id?: number })?.id ?? -1,
      message: e instanceof Error ? e.message : 'Worker runtime error',
    };
    (self as unknown as Worker).postMessage(response);
  }
};
