import { autoFitText } from './fit-text.js';
import { openInstagramProfile, createAvatar } from './player-modal.js';
import { normalizeInstagram, formatInstagram } from './ranking-client.js';

const SIZES = [128, 96, 64]; // fallback sizes if even the lowest quality doesn't fit
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];
const MAX_DATA_URL_BYTES = 15 * 1024; // keep below the Worker's 16 KB decoded cap
const MAX_INPUT_BYTES = 30 * 1024 * 1024; // refuse absurd files before decoding them

/**
 * Takes ANY photo (a few MB is fine), centre-crops it to a square and shrinks it into a tiny
 * JPEG data URL that fits the Worker cap: lowers quality first, then the pixel size.
 * Throws `not_image`, `too_big_input` or `too_large`.
 */
export async function resizeImageFile(file) {
  if (!file || !String(file.type).startsWith('image/')) throw new Error('not_image');
  if (file.size > MAX_INPUT_BYTES) throw new Error('too_big_input');
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    for (const size of SIZES) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#0b1a14'; // transparent PNGs get the app background, not black
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
      for (const quality of QUALITIES) {
        const url = canvas.toDataURL('image/jpeg', quality);
        if (url.length * 0.75 <= MAX_DATA_URL_BYTES) return url;
      }
    }
    throw new Error('too_large');
  } finally {
    bitmap.close?.();
  }
}

/** Opens the system file picker and resolves with a resized data URL (or null if cancelled). */
export function pickPhoto() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resizeImageFile(file).then(resolve, reject);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * "This is how you'll look" card: avatar + @ exactly as the ranking will show it, a photo
 * picker and a "verify on Instagram" link. Used under the @ input so the player can OK it.
 * @returns {{ setHandle(raw: string): void, getPhoto(): string, reset(): void }}
 */
export function mountProfilePreview(container) {
  let handle = '';
  let photo = '';
  container.classList.add('profile-preview');

  const avatarSlot = document.createElement('div');
  avatarSlot.className = 'profile-preview-avatar';
  const info = document.createElement('div');
  info.className = 'profile-preview-info';
  const name = document.createElement('p');
  name.className = 'profile-preview-name';
  autoFitText(name);
  const hint = document.createElement('p');
  hint.className = 'profile-preview-hint';
  const actions = document.createElement('div');
  actions.className = 'profile-preview-actions';
  const photoBtn = document.createElement('button');
  photoBtn.type = 'button';
  photoBtn.className = 'profile-preview-btn';
  photoBtn.textContent = 'Elegir foto';
  const verifyBtn = document.createElement('button');
  verifyBtn.type = 'button';
  verifyBtn.className = 'profile-preview-btn';
  verifyBtn.textContent = 'Verificar en Instagram ↗';
  actions.append(photoBtn, verifyBtn);
  info.append(name, hint, actions);
  container.append(avatarSlot, info);

  function render() {
    avatarSlot.replaceChildren(createAvatar(handle || '?', { size: 'md', src: photo }));
    name.textContent = handle ? formatInstagram(handle) : '@usuario';
    name.classList.toggle('is-empty', !handle);
    hint.textContent = handle
      ? (photo ? 'Así saldrás en el ranking.' : 'Sin foto: saldrá tu inicial.')
      : 'Escribe tu @ para ver cómo saldrás.';
    verifyBtn.disabled = !handle;
  }

  photoBtn.addEventListener('click', async () => {
    try {
      const picked = await pickPhoto();
      if (picked) photo = picked;
    } catch (err) {
      hint.textContent = err?.message === 'too_big_input'
        ? 'Esa imagen pesa demasiado (máx. 30 MB).'
        : 'No se pudo leer esa imagen. Prueba con un JPG o PNG.';
      return;
    }
    render();
  });
  verifyBtn.addEventListener('click', () => {
    if (handle) void openInstagramProfile(handle);
  });
  render();

  return {
    setHandle(raw) {
      handle = normalizeInstagram(raw) || '';
      render();
    },
    getPhoto: () => photo,
    reset() {
      handle = '';
      photo = '';
      render();
    },
  };
}
