const IG_KEY = 'hortelano:player:instagram';
const IG_DECLINED_KEY = 'hortelano:player:instagram-declined';
const DEVICE_KEY = 'hortelano:player:device-id';

const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;

export function normalizeInstagram(raw) {
  if (raw == null) return '';
  let value = String(raw).trim();
  if (value.startsWith('@')) value = value.slice(1);
  value = value.trim();
  if (!HANDLE_RE.test(value)) return null;
  return value.toLowerCase();
}

export function formatInstagram(handle) {
  if (!handle) return '';
  return `@${handle}`;
}

export function loadInstagram() {
  try {
    const raw = localStorage.getItem(IG_KEY);
    const normalized = normalizeInstagram(raw || '');
    return normalized || '';
  } catch {
    return '';
  }
}

export function saveInstagram(raw) {
  const normalized = normalizeInstagram(raw);
  if (!normalized) return null;
  try {
    localStorage.setItem(IG_KEY, normalized);
  } catch { /* */ }
  return normalized;
}

export function clearInstagram() {
  try {
    localStorage.removeItem(IG_KEY);
  } catch { /* */ }
}

export function loadInstagramDeclined() {
  try {
    return localStorage.getItem(IG_DECLINED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setInstagramDeclined(declined = true) {
  try {
    if (declined) localStorage.setItem(IG_DECLINED_KEY, '1');
    else localStorage.removeItem(IG_DECLINED_KEY);
  } catch { /* */ }
}

function uuidLite() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (id && /^[A-Za-z0-9._:-]{8,64}$/.test(id)) return id;
    id = uuidLite();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return uuidLite();
  }
}
