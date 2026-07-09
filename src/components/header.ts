// Header: badges + sidebar mobile toggle + nav clicks

import { getState } from '../lib/store';
import { switchView } from '../lib/store';
import { showModal } from './modal';

export function updateBadges(): void {
  const state = getState();
  const w = document.getElementById('badge-watching');
  const tw = document.getElementById('badge-towatch');
  const c = document.getElementById('badge-completed');
  const wCount = state.shows.filter((s) => s.list === 'watching').length;
  const twCount = state.shows.filter((s) => s.list === 'towatch').length;
  const cCount = state.shows.filter((s) => s.list === 'completed').length;
  if (w) {
    w.textContent = String(wCount);
    // BUG-20-10: aria-label dinamico per screen reader.
    w.setAttribute('aria-label', wCount + ' serie in corso');
  }
  if (tw) {
    tw.textContent = String(twCount);
    tw.setAttribute('aria-label', twCount + ' serie da vedere');
  }
  if (c) {
    c.textContent = String(cCount);
    c.setAttribute('aria-label', cCount + ' serie completate');
  }
}

export function initHeader(): void {
  // Nav items
  document.querySelectorAll<HTMLElement>('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', () => {
      const view = el.dataset.view;
      if (!view) return;
      switchView(view);
      if (window.matchMedia('(max-width: 900px)').matches) {
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebarOverlay')?.classList.remove('active');
      }
    });
  });

  // About
  document.getElementById('aboutBtn')?.addEventListener('click', () => {
    showModal(
      'Informazioni su PloppyTV',
      "<p>PloppyTV è un'alternativa self-contained a TV Time, funzionante interamente nel browser senza server.</p>" +
        '<p><strong>Caratteristiche:</strong></p>' +
        '<ul style="margin-left:20px;margin-bottom:10px;">' +
        '<li>Tracking serie TV ed episodi visti</li><li>Liste personalizzate (In corso, Da vedere, Completate)</li>' +
        '<li>Calendario settimanale con airdate reali</li><li>Statistiche dettagliate</li>' +
        '<li>Dati salvati localmente nel browser</li><li>Compatibile con tutti i browser moderni</li>' +
        '</ul>' +
        '<p><strong>Dati:</strong> API TVMaze (gratuita, senza chiave)</p>' +
        '<hr style="border:0;border-top:1px solid var(--border);margin:14px 0;">' +
        '<p style="font-size:13px;"><strong>Versione 1.1</strong> — fondamenta & igiene del progetto</p>' +
        '<p style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">' +
        'Build pipeline moderna: <strong>Vite + TypeScript</strong>, ' +
        'codice suddiviso in moduli, <strong>Web Worker</strong> per statistiche e calendario (UI non si blocca), ' +
        'code-splitting delle viste (chunk separati lazy-loadati), Service Worker basato su <strong>Workbox</strong> con expiration plugin.' +
        '</p>' +
        '<p style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">' +
        'Rispetto alla versione 1.0 (file HTML singolo da 114 KB): carico iniziale <strong>-26% gzip</strong>, cache più granulare, debugging più semplice.' +
        '</p>' +
        '<p style="font-size:11px;color:var(--text-muted);">' +
        'Se vedi questa nota, stai usando la versione refactorata. ' +
        'Per verificarlo in DevTools → Sources: dovresti vedere chunk separati come <code>discover-*.js</code>, <code>calendar-*.js</code>, <code>stats-*.js</code> e un <code>stats.worker-*.js</code>.' +
        '</p>' +
        '<p style="font-size:12px;color:var(--text-muted);margin-top:10px;">I tuoi dati sono salvati solo nel tuo browser (localStorage). Usa Esporta/Importa per i backup.</p>' +
        '<hr style="border:0;border-top:1px solid var(--border);margin:14px 0;">' +
        '<p style="font-size:12px;color:var(--text-secondary);">' +
        '<a href="https://github.com/Cartaz/PloppyTV/blob/main/PRIVACY.md" target="_blank" rel="noopener">Privacy Policy</a> · ' +
        '<a href="https://github.com/Cartaz/PloppyTV/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener">Contribuire</a> · ' +
        '<a href="https://github.com/Cartaz/PloppyTV/blob/main/LICENSE" target="_blank" rel="noopener">Licenza MIT</a>' +
        '</p>' +
        '<p style="font-size:11px;color:var(--text-muted);margin-top:6px;">Versione 1.1.0 · Luglio 2026</p>',
      [{ label: 'Chiudi' }],
    );
  });

  // Sidebar mobile
  document.getElementById('menuToggle')?.addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sidebarOverlay');
    if (!sb || !ov) return;
    if (sb.classList.contains('open')) {
      sb.classList.remove('open');
      ov.classList.remove('active');
    } else {
      sb.classList.add('open');
      ov.classList.add('active');
    }
  });
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('active');
  });

  // Multi-tab badge sync
  window.addEventListener('ploppytv:badges', updateBadges);
}
