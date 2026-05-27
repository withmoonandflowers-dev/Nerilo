/**
 * Sentry Error Tracking Configuration
 *
 * Setup:
 *   1. Create a Sentry project at https://sentry.io (React platform)
 *   2. Copy the DSN into VITE_SENTRY_DSN in .env.{staging,production}
 *   3. Deploy — errors will appear in the Sentry dashboard
 *
 * When VITE_SENTRY_DSN is unset (e.g. local dev), initSentry() is a no-op
 * and captureError() silently drops the error. No setup is required to
 * develop without Sentry.
 */

import * as Sentry from '@sentry/react';

const SENTRY_DSN = import.meta.env?.VITE_SENTRY_DSN;
const DEPLOY_ENV =
  (import.meta.env?.VITE_DEPLOY_ENV as string | undefined) ?? import.meta.env.MODE;

export function initSentry(): void {
  if (!SENTRY_DSN) return;

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: DEPLOY_ENV,
    // 10% tracing in prod, off elsewhere. Session Replay only on errors.
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: import.meta.env.PROD ? 0.5 : 0,
    // Drop noise from local dev URLs even if a DSN is mistakenly set.
    beforeSend(event) {
      if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
        return null;
      }
      return event;
    },
    integrations: [
      Sentry.browserTracingIntegration(),
      // maskAllText + blockAllMedia: never capture user content in replays.
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
  });
}

/**
 * Manual capture for errors caught in try/catch blocks (i.e. not unhandled).
 * No-op when Sentry isn't initialized.
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!SENTRY_DSN) return;
  Sentry.captureException(error, { extra: context });
}

/** Re-export the React ErrorBoundary integration. Used by ErrorBoundary. */
export { Sentry };
