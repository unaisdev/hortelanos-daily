import { autoFitText } from './fit-text.js';
import {
  clearInstagram,
  fetchAllTimeRanking,
  fetchRanking,
  formatInstagram,
  identityErrorMessage,
  identityErrorNeedsContact,
  SUPPORT_DM_URL,
  SUPPORT_HANDLE,
  loadInstagram,
  loadInstagramDeclined,
  normalizeInstagram,
  rankingEnabled,
  saveInstagram,
  setIdentity,
  setInstagramDeclined,
  submitWin,
} from './ranking-client.js';
import { createAvatar, openExternalLink, openPlayerModal } from './player-modal.js';

const PREVIEW_LIMIT = 5;

/**
 * Writes a status line. When `error` is one where the player should contact us (blocked @),
 * a link opens a direct message to the support account on Instagram.
 */
export function setStatusText(el, text, error = '') {
  if (!el) return;
  el.replaceChildren(document.createTextNode(text));
  if (!identityErrorNeedsContact(error)) return;
  const link = document.createElement('a');
  link.className = 'support-link';
  link.href = SUPPORT_DM_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `Escribir a @${SUPPORT_HANDLE} ↗`;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    void openExternalLink(SUPPORT_DM_URL);
  });
  el.append(' ', link);
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

/**
 * `ctx.mode`: 'today' shows the win time, 'all' shows total wins + current streak.
 * Clicking a name opens the player card (`ctx.gameId` limits it to one ROM).
 */
function appendRankingItems(ol, entries, highlight, ctx = {}) {
  const mode = ctx.mode || 'today';
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'ranking-item';
    const handle = entry.instagram || '';
    if (highlight && handle === highlight) li.classList.add('is-you');

    const rank = document.createElement('span');
    rank.className = 'ranking-rank';
    rank.textContent = String(entry.rank ?? '');

    const who = document.createElement('button');
    who.type = 'button';
    who.className = 'ranking-handle';
    who.title = 'Ver perfil';
    const name = document.createElement('span');
    name.className = 'ranking-handle-name';
    autoFitText(name);
    name.textContent = entry.display || formatInstagram(handle);
    // `photo: true` layers the player's picture over the coloured initial (404 ⇒ initial stays).
    who.append(createAvatar(handle, { photo: true }), name);
    who.addEventListener('click', () => {
      void openPlayerModal(handle, { gameId: ctx.profileGameId || '' });
    });

    const side = document.createElement('span');
    side.className = 'ranking-time';
    if (mode === 'all') {
      const wins = Number(entry.wins) || 0;
      const streak = Number(entry.current_streak) || 0;
      // Compact on purpose: the side panel is narrow and the @ must not get truncated.
      side.textContent = `${wins} 🏆${streak > 1 ? ` 🔥${streak}` : ''}`;
      side.title = `${wins} ${wins === 1 ? 'victoria' : 'victorias'}${streak > 1 ? ` · racha de ${streak} días` : ''}`;
    } else {
      side.textContent = formatWonAt(entry.won_at);
    }

    li.append(rank, who, side);
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

export function openRankingModal(
  entries,
  { highlight = '', title = 'Ranking de hoy', mode = 'today', profileGameId = '' } = {},
) {
  const dialog = ensureRankingModal();
  const titleEl = dialog.querySelector('#ranking-modal-title');
  const statusEl = dialog.querySelector('#ranking-modal-status');
  const boardEl = dialog.querySelector('#ranking-modal-board');
  if (titleEl) titleEl.textContent = title;
  if (statusEl) {
    if (!entries.length) statusEl.textContent = 'Aún nadie en el ranking';
    else if (mode === 'all') statusEl.textContent = `${entries.length} jugadores`;
    else statusEl.textContent = `${entries.length} victorias`;
  }
  if (boardEl) {
    boardEl.replaceChildren();
    if (!entries.length) {
      boardEl.appendChild(buildRankingEmpty());
    } else {
      const ol = document.createElement('ol');
      ol.className = 'ranking-list ranking-list-full';
      appendRankingItems(ol, entries, highlight, { mode, profileGameId });
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
  mode = 'today',
  profileGameId = '',
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
  appendRankingItems(ol, preview, highlight, { mode, profileGameId });
  container.appendChild(ol);

  if (entries.length > PREVIEW_LIMIT) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ranking-more';
    more.textContent = `Ver más (${entries.length - PREVIEW_LIMIT})`;
    more.addEventListener('click', () => {
      openRankingModal(entries, { highlight, title: modalTitle, mode, profileGameId });
    });
    container.appendChild(more);
  }
}

export async function loadRankingInto(boardEl, statusEl, gameId, playDate, options = {}) {
  const enabled = await rankingEnabled(gameId);
  if (options.isCurrent?.() === false) return;
  const wrap = boardEl?.closest?.('.ranking-panel');
  if (!enabled) {
    if (wrap) wrap.hidden = true;
    return { ok: false, disabled: true, entries: [] };
  }
  if (wrap) wrap.hidden = false;
  if (statusEl) statusEl.textContent = 'Cargando…';
  const result = await fetchRanking(gameId, playDate);
  if (options.isCurrent?.() === false) return;
  if (result.disabled) {
    if (wrap) wrap.hidden = true;
    return result;
  }
  if (statusEl) {
    if (!result.ok) statusEl.textContent = 'Sin conexión al ranking';
    else if (result.entries.length) statusEl.textContent = `${result.entries.length} han ganado hoy`;
    else statusEl.textContent = 'Vacío';
  }
  renderRankingList(boardEl, result.ok ? result.entries : [], {
    highlight: loadInstagram(),
    modalTitle: options.modalTitle || 'Ranking de hoy',
    profileGameId: gameId,
    emptyTitle: result.ok ? 'Nadie ha ganado todavía' : 'No se pudo cargar',
    emptyCopy: result.ok
      ? 'Sé el primero en aparecer aquí cuando ganes el combate de hoy.'
      : 'Revisa la conexión y vuelve a abrir el menú.',
  });
  return result;
}

/** All-time ranking of ONE ROM (most wins first) into the same panel. */
export async function loadAllTimeRankingInto(boardEl, statusEl, gameId, options = {}) {
  const enabled = await rankingEnabled(gameId);
  if (options.isCurrent?.() === false) return;
  const wrap = boardEl?.closest?.('.ranking-panel');
  if (!enabled) {
    if (wrap) wrap.hidden = true;
    return { ok: false, disabled: true, entries: [] };
  }
  if (wrap) wrap.hidden = false;
  if (statusEl) statusEl.textContent = 'Cargando…';
  const result = await fetchAllTimeRanking(gameId); // per ROM: each game has its own board
  if (options.isCurrent?.() === false) return;
  if (result.disabled) {
    if (wrap) wrap.hidden = true;
    return result;
  }
  if (statusEl) {
    if (!result.ok) statusEl.textContent = 'Sin conexión al ranking';
    else if (result.entries.length) statusEl.textContent = `${result.entries.length} jugadores`;
    else statusEl.textContent = 'Vacío';
  }
  renderRankingList(boardEl, result.ok ? result.entries : [], {
    highlight: loadInstagram(),
    modalTitle: options.modalTitle || 'Más victorias',
    mode: 'all',
    profileGameId: gameId,
    emptyTitle: result.ok ? 'Aún no hay victorias' : 'No se pudo cargar',
    emptyCopy: result.ok
      ? 'Cuando alguien gane, aparecerá aquí con su historial.'
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
  if (!identity.ok && ['rename_limit', 'handle_released', 'instagram_taken'].includes(identity.error)) {
    clearInstagram();
    if (typeof window !== 'undefined') {
      // alert() can't hold a link, so print the address for blocked @s.
      const extra = identityErrorNeedsContact(identity.error)
        ? `\n\nEscribe a @${SUPPORT_HANDLE}: ${SUPPORT_DM_URL}`
        : '';
      window.alert(identityErrorMessage(identity.error) + extra);
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
        instagram_taken: identityErrorMessage('instagram_taken'),
        handle_released: identityErrorMessage('handle_released'),
        rename_limit: identityErrorMessage('rename_limit'),
        seed_mismatch: 'Seed no válida para hoy.',
        rate_limited: 'Demasiados intentos; espera un minuto.',
        day_full: 'Ranking del día lleno.',
        network: 'Sin red; se reintentará luego.',
        timeout: 'El ranking no respondió a tiempo.',
      };
      setStatusText(statusEl, map[result.error] || 'No se pudo publicar el ranking.', result.error);
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
  fetchAllTimeRanking,
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
