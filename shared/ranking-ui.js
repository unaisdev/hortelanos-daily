import {
  clearInstagram,
  fetchRanking,
  formatInstagram,
  loadInstagram,
  loadInstagramDeclined,
  normalizeInstagram,
  rankingEnabled,
  saveInstagram,
  setIdentity,
  setInstagramDeclined,
  submitWin,
} from './ranking-client.js';
import { isDesktop, openExternalUrl } from '../shell/desktop.js';

const PREVIEW_LIMIT = 5;

function instagramProfileUrl(handle) {
  return `https://www.instagram.com/${encodeURIComponent(handle)}/`;
}

async function openInstagramProfile(handle, event) {
  if (event) event.preventDefault();
  const url = instagramProfileUrl(handle);
  try {
    if (isDesktop()) await openExternalUrl(url);
    else window.open(url, '_blank', 'noopener');
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

function formatWonAt(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function appendRankingItems(ol, entries, highlight) {
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'ranking-item';
    const handle = entry.instagram || '';
    if (highlight && handle === highlight) li.classList.add('is-you');

    const rank = document.createElement('span');
    rank.className = 'ranking-rank';
    rank.textContent = String(entry.rank ?? '');

    const link = document.createElement('a');
    link.className = 'ranking-handle';
    link.href = instagramProfileUrl(handle);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = entry.display || formatInstagram(handle);
    link.addEventListener('click', (event) => {
      openInstagramProfile(handle, event);
    });

    const time = document.createElement('span');
    time.className = 'ranking-time';
    time.textContent = formatWonAt(entry.won_at);

    li.append(rank, link, time);
    ol.appendChild(li);
  }
}

function ensureRankingModal() {
  let dialog = document.getElementById('ranking-modal');
  if (dialog) return dialog;

  dialog = document.createElement('dialog');
  dialog.id = 'ranking-modal';
  dialog.className = 'ranking-modal';
  dialog.setAttribute('aria-labelledby', 'ranking-modal-title');
  dialog.innerHTML = `
    <div class="ranking-modal-card">
      <header class="ranking-modal-head">
        <h2 id="ranking-modal-title">Ranking de hoy</h2>
        <button type="button" class="ranking-modal-close" aria-label="Cerrar">×</button>
      </header>
      <p class="ranking-modal-status" id="ranking-modal-status"></p>
      <div class="ranking-modal-board" id="ranking-modal-board"></div>
    </div>
  `;
  document.body.appendChild(dialog);

  const closeBtn = dialog.querySelector('.ranking-modal-close');
  closeBtn?.addEventListener('click', () => closeRankingModal());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeRankingModal();
  });
  return dialog;
}

export function closeRankingModal() {
  const dialog = document.getElementById('ranking-modal');
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

export function openRankingModal(entries, { highlight = '', title = 'Ranking de hoy' } = {}) {
  const dialog = ensureRankingModal();
  const titleEl = dialog.querySelector('#ranking-modal-title');
  const statusEl = dialog.querySelector('#ranking-modal-status');
  const boardEl = dialog.querySelector('#ranking-modal-board');
  if (titleEl) titleEl.textContent = title;
  if (statusEl) {
    statusEl.textContent = entries.length
      ? `${entries.length} victorias`
      : 'Aún nadie en el ranking';
  }
  if (boardEl) {
    boardEl.replaceChildren();
    if (!entries.length) {
      boardEl.appendChild(buildRankingEmpty());
    } else {
      const ol = document.createElement('ol');
      ol.className = 'ranking-list ranking-list-full';
      appendRankingItems(ol, entries, highlight);
      boardEl.appendChild(ol);
    }
  }
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function buildRankingEmpty({
  title = 'Nadie ha ganado todavía',
  copy = 'Sé el primero en aparecer aquí cuando ganes el combate de hoy.',
} = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'ranking-empty';
  wrap.setAttribute('role', 'status');

  const mark = document.createElement('span');
  mark.className = 'ranking-empty-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = '#';

  const titleEl = document.createElement('p');
  titleEl.className = 'ranking-empty-title';
  titleEl.textContent = title;

  const copyEl = document.createElement('p');
  copyEl.className = 'ranking-empty-copy';
  copyEl.textContent = copy;

  wrap.append(mark, titleEl, copyEl);
  return wrap;
}

/**
 * Renders a compact preview (max 5). Extra entries behind "Ver más" modal.
 */
export function renderRankingList(container, entries, {
  emptyTitle = 'Nadie ha ganado todavía',
  emptyCopy = 'Sé el primero en aparecer aquí cuando ganes el combate de hoy.',
  highlight = '',
  modalTitle = 'Ranking de hoy',
} = {}) {
  if (!container) return;
  container.replaceChildren();

  if (!entries?.length) {
    container.appendChild(buildRankingEmpty({ title: emptyTitle, copy: emptyCopy }));
    return;
  }

  const preview = entries.slice(0, PREVIEW_LIMIT);
  const ol = document.createElement('ol');
  ol.className = 'ranking-list';
  appendRankingItems(ol, preview, highlight);
  container.appendChild(ol);

  if (entries.length > PREVIEW_LIMIT) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ranking-more';
    more.textContent = `Ver más (${entries.length - PREVIEW_LIMIT})`;
    more.addEventListener('click', () => {
      openRankingModal(entries, { highlight, title: modalTitle });
    });
    container.appendChild(more);
  }
}

export async function loadRankingInto(boardEl, statusEl, gameId, playDate, options = {}) {
  if (!(await rankingEnabled(gameId))) {
    const wrap = boardEl?.closest?.('.ranking-panel');
    if (wrap) wrap.hidden = true;
    return { ok: false, disabled: true, entries: [] };
  }
  const wrap = boardEl?.closest?.('.ranking-panel');
  if (wrap) wrap.hidden = false;
  if (statusEl) statusEl.textContent = 'Cargando…';
  const result = await fetchRanking(gameId, playDate);
  if (statusEl) {
    if (!result.ok) statusEl.textContent = 'Sin conexión al ranking';
    else if (result.entries.length) statusEl.textContent = `${result.entries.length} han ganado hoy`;
    else statusEl.textContent = 'Vacío';
  }
  renderRankingList(boardEl, result.ok ? result.entries : [], {
    highlight: loadInstagram(),
    modalTitle: options.modalTitle || 'Ranking de hoy',
    emptyTitle: result.ok ? 'Nadie ha ganado todavía' : 'No se pudo cargar',
    emptyCopy: result.ok
      ? 'Sé el primero en aparecer aquí cuando ganes el combate de hoy.'
      : 'Revisa la conexión y vuelve a abrir el menú.',
  });
  return result;
}

export async function promptInstagramIfNeeded() {
  let handle = loadInstagram();
  if (handle) return handle;
  const raw = typeof window !== 'undefined'
    ? window.prompt('Tu @ de Instagram para el ranking diario:', '@')
    : null;
  handle = saveInstagram(raw || '');
  if (!handle) return null;
  const identity = await setIdentity({ instagram: handle });
  if (!identity.ok && identity.error === 'rename_limit') {
    if (typeof window !== 'undefined') {
      window.alert('Solo puedes cambiar de @ 2 veces al día.');
    }
    return null;
  }
  return handle;
}

export async function submitWinAndRefresh({ gameId, playDate, seed, boardEl, statusEl }) {
  if (!(await rankingEnabled(gameId))) return { ok: false, disabled: true };

  let handle = loadInstagram();
  if (!handle) handle = await promptInstagramIfNeeded();
  if (!handle) {
    if (statusEl) statusEl.textContent = 'Añade tu @ de Instagram para aparecer en el ranking.';
    return { ok: false, error: 'instagram_required' };
  }

  if (statusEl) statusEl.textContent = 'Enviando victoria…';
  const result = await submitWin({ gameId, playDate, seed, instagram: handle });
  if (!result.ok) {
    if (statusEl) {
      const map = {
        instagram_taken: 'Ese @ ya está en el ranking de hoy.',
        seed_mismatch: 'Seed no válida para hoy.',
        rate_limited: 'Demasiados intentos; espera un minuto.',
        day_full: 'Ranking del día lleno.',
        network: 'Sin red; se reintentará luego.',
        timeout: 'El ranking no respondió a tiempo.',
      };
      statusEl.textContent = map[result.error] || 'No se pudo publicar el ranking.';
    }
    return result;
  }

  if (boardEl) {
    renderRankingList(boardEl, result.entries, { highlight: normalizeInstagram(handle) });
  }
  if (statusEl) {
    statusEl.textContent = result.rank
      ? `¡Publicado! Posición #${result.rank}`
      : 'Victoria publicada en el ranking.';
  }
  return result;
}

export {
  fetchRanking,
  rankingEnabled,
  loadInstagram,
  saveInstagram,
  clearInstagram,
  loadInstagramDeclined,
  setInstagramDeclined,
  formatInstagram,
  normalizeInstagram,
  setIdentity,
  submitWin,
  PREVIEW_LIMIT,
};
