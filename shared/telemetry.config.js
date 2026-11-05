/**
 * Defaults públicos (sin secretos). El DSN y overrides van en
 * `telemetry.secrets.js` (gitignored) o se inyectan en CI desde GitHub Secrets.
 * Ver docs/TELEMETRY.md.
 */
export default {
  /** Siempre vacío en git. Se sobrescribe vía secrets / inject. */
  sentryDsn: '',

  /** Release tag visible en Sentry (alinear con package.json / tag v*). */
  release: 'hortelanos-daily@1.0.1',

  /** Entorno lógico. */
  environment: 'production',

  /** 0–1; 1 = todos los eventos de producto. */
  tracesSampleRate: 1,

  /** Prefijo de claves en localStorage / sessionStorage. */
  storagePrefix: 'hortelano:telemetry:',
};
