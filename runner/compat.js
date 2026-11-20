import { hasProtocolAdapter } from './protocols/index.js';

export async function getLauncherVersion() {
  const response = await fetch(new URL('../catalog/catalog.json', import.meta.url));
  if (!response.ok) throw new Error('No se pudo cargar el catálogo del lanzador.');
  const { launcher } = await response.json();
  if (!launcher?.version) throw new Error('El catálogo no declara la versión del lanzador.');
  return launcher.version;
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
export function checkGameCompat(manifest, launcherVersion) {
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
  if (min && compareSemver(launcherVersion, min) < 0) {
    return {
      ok: false,
      code: 'launcher-too-old',
      message: `Este pack pide Hortelano's Daily ≥ ${min} (tienes ${launcherVersion}). Actualiza el launcher.`,
    };
  }
  if (manifest.status === 'awaiting-content-pack') {
    return {
      ok: false,
      code: 'no-content',
      message: manifest.notes
        || 'Sin ROM local. Descárgala con U o publícala desde el repo del juego vía GitHub Releases.',
    };
  }
  return { ok: true };
}
