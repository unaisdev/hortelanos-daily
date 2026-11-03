import { hasProtocolAdapter } from './protocols/index.js';

const LAUNCHER_VERSION = '0.1.0';

export function getLauncherVersion() {
  return LAUNCHER_VERSION;
}

/** Semver simple a-b: -1 si a<b, 0 igual, 1 si a>b */
export function compareSemver(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/**
 * Valida manifest antes de jugar.
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function checkGameCompat(manifest) {
  if (!manifest?.protocolId) {
    return { ok: false, code: 'no-protocol', message: 'El pack no declara protocolId.' };
  }
  if (!hasProtocolAdapter(manifest.protocolId)) {
    return {
      ok: false,
      code: 'unknown-protocol',
      message: `Este juego usa el protocolo «${manifest.protocolId}», que este launcher no entiende. Actualiza Hortelano's Daily.`,
    };
  }
  const min = manifest.compat?.minLauncherVersion;
  if (min && compareSemver(LAUNCHER_VERSION, min) < 0) {
    return {
      ok: false,
      code: 'launcher-too-old',
      message: `Este pack pide Hortelano's Daily ≥ ${min} (tienes ${LAUNCHER_VERSION}). Actualiza el launcher.`,
    };
  }
  if (manifest.status === 'awaiting-content-pack') {
    return {
      ok: false,
      code: 'no-content',
      message: manifest.notes
        || 'Falta el content pack (ROM). Publícalo desde el repo del juego vía GitHub Releases.',
    };
  }
  return { ok: true };
}
