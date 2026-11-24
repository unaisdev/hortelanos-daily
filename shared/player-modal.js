import { autoFitText } from './fit-text.js';
import { avatarUrl, fetchPlayer, formatInstagram, normalizeInstagram } from './ranking-client.js';
import { isDesktop, openExternalUrl } from '../shell/desktop.js';

const HISTORY_PREVIEW = 6;
const MODAL_ID = 'player-modal';

/** game id → display name; the shell fills it from the installed packs. */
let gameNames = { dailygold: 'Daily Gold' };

export function setGameNames(map) {
  gameNames = { ...gameNames, ...(map || {}) };
}

function gameLabel(gameId) {
  return gameNames[gameId] || String(gameId || '').replace(/[-_]+/g, ' ');
}

function instagramProfileUrl(handle) {
  return `https://www.instagram.com/${encodeURIComponent(handle)}/`;
}

export async function openInstagramProfile(handle) {
  const url = instagramProfileUrl(handle);
  try {
    if (isDesktop()) await openExternalUrl(url);
    else window.open(url, '_blank', 'noopener');
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

/** Day `YYYY-MM-DD` → "24 nov 2026" (UTC, so the day never shifts with the timezone). */
function formatDay(isoDay) {
  const d = new Date(`${isoDay}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDay;
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatShortDay(isoDay) {
  const d = new Date(`${isoDay}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDay;
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function hueFor(handle) {
  let h = 0;
  for (const ch of handle) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * Round avatar: a coloured initial that always renders; with `photo` the Instagram picture
 * (served by the Worker) is layered on top once it loads. If it 404s the initial stays.
 */
export function createAvatar(handle, { photo = false, size = 'sm', src = '', bust = '' } = {}) {
  const clean = normalizeInstagram(handle) || '?';
  const el = document.createElement('span');
  el.className = `avatar avatar-${size}`;
  el.style.setProperty('--avatar-hue', String(hueFor(clean)));
  el.setAttribute('aria-hidden', 'true');
  el.textContent = clean.charAt(0).toUpperCase();
  const show = (url) => {
    if (!url) return;
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', () => {
      el.textContent = '';
      el.classList.add('has-photo');
      el.replaceChildren(img);
    });
    img.src = url;
  };
  if (src) show(src); // explicit image (e.g. a local preview)
  else if (photo) void avatarUrl(clean, bust).then(show);
  return el;
}

function statCard(value, label) {
  const card = document.createElement('div');
  card.className = 'player-stat';
  const v = document.createElement('strong');
  v.className = 'player-stat-value';
  v.textContent = value;
  const l = document.createElement('span');
  l.className = 'player-stat-label';
  l.textContent = label;
  card.append(v, l);
  return card;
}

function historyRow(item) {
  const li = document.createElement('li');
  li.className = 'player-history-item';
  const day = document.createElement('span');
  day.className = 'player-history-day';
  day.textContent = formatDay(item.play_date);
  const rom = document.createElement('span');
  rom.className = 'player-history-rom';
  rom.textContent = gameLabel(item.game_id);
  const ok = document.createElement('span');
  ok.className = 'player-history-ok';
  ok.setAttribute('aria-label', 'Victoria');
  ok.textContent = '✓';
  li.append(day, rom, ok);
  return li;
}

function brokenRow(brokenOn) {
  const li = document.createElement('li');
  li.className = 'player-history-break';
  li.textContent = `racha rota: ${formatShortDay(brokenOn)}`;
  return li;
}

function renderHistory(listEl, moreBtn, history) {
  const render = (limit) => {
    listEl.replaceChildren();
    const rows = history.slice(0, limit);
    rows.forEach((item, i) => {
      // The marker sits between this win and the NEWER one that came after the gap.
      if (item.broken_on && i > 0) listEl.appendChild(brokenRow(item.broken_on));
      listEl.appendChild(historyRow(item));
    });
    const hidden = history.length - rows.length;
    moreBtn.hidden = hidden <= 0;
    moreBtn.textContent = `Ver más (${hidden})`;
  };
  moreBtn.onclick = () => render(history.length);
  render(HISTORY_PREVIEW);
}

function ensureModal() {
  let dialog = document.getElementById(MODAL_ID);
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = MODAL_ID;
  dialog.className = 'help-modal player-modal';
  dialog.setAttribute('aria-labelledby', 'player-modal-title');
  dialog.innerHTML = `
    <div class="help-modal-card player-modal-card">
      <header class="help-modal-head">
        <h2 id="player-modal-title"></h2>
        <button type="button" class="help-modal-close" aria-label="Cerrar">×</button>
      </header>
      <div class="player-modal-body"></div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector('.help-modal-close')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  return dialog;
}

function showMessage(body, text) {
  const p = document.createElement('p');
  p.className = 'player-modal-msg';
  p.setAttribute('role', 'status');
  p.textContent = text;
  body.replaceChildren(p);
}

/**
 * Player card: avatar, rank, wins, streaks and win history (day + ROM).
 * @param {string} handle Instagram handle (with or without @)
 * @param {{ gameId?: string }} [options] restrict to one ROM; default sums all ROMs
 */
export async function openPlayerModal(handle, { gameId = '' } = {}) {
  const clean = normalizeInstagram(handle);
  if (!clean) return;
  const dialog = ensureModal();
  const title = dialog.querySelector('#player-modal-title');
  autoFitText(title, { minPx: 7 });
  const body = dialog.querySelector('.player-modal-body');
  title.textContent = formatInstagram(clean);
  showMessage(body, 'Cargando…');
  if (!dialog.open) dialog.showModal();

  const result = await fetchPlayer(clean, gameId);
  if (!dialog.open || title.textContent !== formatInstagram(clean)) return; // closed / replaced
  if (!result.ok) {
    showMessage(
      body,
      result.status === 404 ? 'Este jugador aún no tiene victorias.' : 'No se pudo cargar el perfil.',
    );
    return;
  }

  const p = result.player;
  body.replaceChildren();

  const hero = document.createElement('div');
  hero.className = 'player-hero';
  const rank = document.createElement('p');
  rank.className = 'player-rank';
  rank.textContent = `🏆 #${p.rank} en el ranking`;
  hero.append(createAvatar(clean, { photo: true, size: 'lg' }), rank);

  const stats = document.createElement('div');
  stats.className = 'player-stats';
  stats.append(
    statCard(String(p.wins), p.wins === 1 ? 'victoria' : 'victorias'),
    statCard(`🔥 ${p.current_streak}`, 'racha actual'),
    statCard(`🔥 ${p.best_streak}`, 'mejor racha'),
  );

  const heading = document.createElement('h3');
  heading.className = 'player-history-title';
  heading.textContent = 'Historial';
  const list = document.createElement('ul');
  list.className = 'player-history';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'ranking-more';
  renderHistory(list, more, p.history || []);

  const ig = document.createElement('button');
  ig.type = 'button';
  ig.className = 'player-ig-link';
  ig.textContent = 'Abrir en Instagram ↗';
  ig.addEventListener('click', () => void openInstagramProfile(clean));

  body.append(hero, stats, heading, list, more, ig);
}
