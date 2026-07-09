// Header: badges + sidebar mobile toggle + nav clicks

import { getState } from '../lib/store';
import { switchView } from '../lib/store';
import { showModal } from './modal';
import { showToast } from './toast';
import { getLocale, setLocale, getAvailableLocales, t } from '../lib/i18n';
import { escapeHtml, escapeAttr } from '../lib/utils';
import {
  notificationsSupported,
  notificationsEnabled,
  enableNotifications,
  disableNotifications,
  isPwaStandalone,
  getNextNotifiableEpisode,
} from '../lib/notifications';

let _headerInitialized = false;

export function updateBadges(): void {
  const state = getState();
  const w = document.getElementById('badge-watching');
  const tw = document.getElementById('badge-towatch');
  const c = document.getElementById('badge-completed');
  // BUG-A17-09 (FIXED): defensive guard — se state.shows è corrotto (non-array),
  // filter crashava con TypeError. Ora si conta 0 (consistente con store.setShows
  // che resetta a [] su input invalido, ma defense-in-depth).
  const shows = Array.isArray(state.shows) ? state.shows : [];
  const wCount = shows.filter((s) => s && s.list === 'watching').length;
  const twCount = shows.filter((s) => s && s.list === 'towatch').length;
  const cCount = shows.filter((s) => s && s.list === 'completed').length;
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

/**
 * Chiude la sidebar mobile: rimuove classi 'open'/'active' e ripristina
 * lo scroll del body. Centralizza la logica di chiusura per evitare
 * che un path dimentichi di ripristinare overflow (BUG-A17-11).
 */
function closeSidebar(): void {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarOverlay')?.classList.remove('active');
  // BUG-A17-11 (FIXED): ripristina body.overflow alla chiusura.
  // Prima il menuToggle impostava overflow='hidden' all'apertura ma nessuno
  // lo ripristinava alla chiusura via overlay-click o nav-item click.
  document.body.style.overflow = '';
}

export function initHeader(): void {
  // BUG-A17-10 (FIXED): idempotency guard. Prima initHeader non aveva guard
  // e aggiungeva listener duplicati ad ogni chiamata (nav-items, menuToggle,
  // aboutBtn, notifBtn, langBtn, overlay, window). In production era chiamata
  // una sola volta, ma in test/HMR o se main.ts venisse re-eseguito, i
  // listener si accumulavano → click multipli per azione singola.
  if (_headerInitialized) return;
  _headerInitialized = true;

  // Nav items
  document.querySelectorAll<HTMLElement>('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', () => {
      const view = el.dataset.view;
      if (!view) return;
      switchView(view);
      if (window.matchMedia('(max-width: 900px)').matches) {
        closeSidebar();
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
      closeSidebar();
    } else {
      sb.classList.add('open');
      ov.classList.add('active');
      // BUG-A17-11 (FIXED): blocca scroll del body quando la sidebar è aperta
      // (mobile). Prima il body scorreva dietro l'overlay, peggiorando UX.
      document.body.style.overflow = 'hidden';
    }
  });
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    // BUG-A17-11: usa closeSidebar per ripristinare overflow.
    closeSidebar();
  });

  // BUG-A17-12 (FIXED): ESC chiude la sidebar mobile. Prima non c'era handler
  // ESC per la sidebar — solo l'overlay click la chiudeva. Accessibilità WAI-ARIA
  // richiede ESC per dismissable overlays. Non interferisce con modali (controlla
  // aria-hidden del modal overlay prima di agire).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const sb = document.getElementById('sidebar');
    if (!sb || !sb.classList.contains('open')) return;
    // Non chiudere la sidebar se un modale è aperto (il modale gestisce ESC).
    const modal = document.getElementById('modal');
    if (modal && modal.getAttribute('aria-hidden') === 'false') return;
    closeSidebar();
  });

  // Multi-tab badge sync
  window.addEventListener('ploppytv:badges', updateBadges);

  // P2.9: Notifications toggle
  document.getElementById('notifBtn')?.addEventListener('click', async () => {
    if (!notificationsSupported()) {
      showToast(t('notifications.pwaRequired'), 'warning');
      return;
    }
    if (notificationsEnabled()) {
      disableNotifications();
      showToast(t('notifications.disabled'), 'success');
      return;
    }
    if (!isPwaStandalone()) {
      // Avvisa ma permetti comunque l'attivazione
      console.warn('[notifications] Not in standalone mode');
    }
    const ok = await enableNotifications();
    if (ok) {
      const next = getNextNotifiableEpisode();
      const msg = next
        ? t('notifications.scheduled', { count: '1+' }) + ' — ' + next.showName + ' S' + next.season + 'E' + next.num
        : t('notifications.enabled');
      showToast(msg, 'success');
    } else {
      showToast(t('notifications.denied'), 'warning');
    }
  });

  // BUG-A17-13 (FIXED): delegated click handler per [data-lang] su document.
  // Prima il binding era via setTimeout(50) dopo showModal — fragile (race
  // con rendering modale, querySelectorAll poteva beccare bottoni di modali
  // precedenti, listener duplicati ad apertura ripetuta). Ora un singolo
  // listener delegato gestisce tutti i click [data-lang] correnti e futuri.
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const langEl = target.closest('[data-lang]') as HTMLElement | null;
    if (!langEl) return;
    const lang = langEl.dataset.lang;
    if (lang === 'it' || lang === 'en') {
      setLocale(lang);
      // Il re-render è triggerato da subscribeI18n nel main.ts
    }
  });

  // P2.7: Language switcher
  document.getElementById('langBtn')?.addEventListener('click', () => {
    const current = getLocale();
    const locales = getAvailableLocales();
    const labels: Record<string, string> = { it: 'Italiano', en: 'English' };
    // BUG-A17-14 (FIXED): escapa il codice lingua e la label nell'HTML.
    // Prima `l` era interpolato raw in data-lang — se getAvailableLocales
    // restituisse un locale con `"` o `<`, si aveva breakout attributo/HTML.
    // Defense-in-depth (i locale sono controllati, ma l'escape è gratuito).
    const bodyHtml =
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
      locales
        .map(
          (l) =>
            '<button class="btn ' +
            (l === current ? 'btn-primary' : 'btn-secondary') +
            '" data-lang="' +
            escapeAttr(l) +
            '" style="text-align:left;">' +
            (l === current ? '✓ ' : '') +
            escapeHtml(labels[l] ?? l) +
            '</button>',
        )
        .join('') +
      '</div>';
    showModal(t('nav.menu') + ' — Lingua', bodyHtml, [{ label: t('actions.close') }]);
  });
}
