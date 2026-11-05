/**
 * Config pública de telemetría (DSN de Sentry es write-only; no es un secreto de cuenta).
 * Dejar `sentryDsn` vacío desactiva el envío remoto — el código sigue siendo no-op seguro.
 *
 * Cómo activar: crear un proyecto Sentry (Browser) y pegar el DSN aquí.
 * Ver docs/TELEMETRY.md.
 */
export default {
  /** @type {string} */
  sentryDsn: '',

  /** Release tag visible en Sentry (alinear con package.json / tag v*). */
  release: 'hortelanos-daily@1.0.0',

  /** Entorno lógico. */
  environment: 'production',

  /** 0–1; 1 = todos los eventos de producto. */
  tracesSampleRate: 1,

  /** Prefijo de claves en localStorage / sessionStorage. */
  storagePrefix: 'hortelano:telemetry:',
};
