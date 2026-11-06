/**
 * Copia este archivo a `telemetry.secrets.js` (gitignored) para desarrollo local:
 *
 *   cp shared/telemetry.secrets.example.js shared/telemetry.secrets.js
 *
 * O usa `.env` + `node scripts/inject-telemetry-secrets.mjs`
 * (variables HORTELANO_SENTRY_DSN, opcionalmente HORTELANO_TELEMETRY_ENV / RELEASE).
 *
 * En CI/release el DSN vive en el secret de GitHub `HORTELANO_SENTRY_DSN`
 * y se inyecta al build — no se sube al repo.
 */
export default {
  sentryDsn: '',
  // environment: 'development',
  // release: 'hortelanos-daily@0.0.0-dev',
};
