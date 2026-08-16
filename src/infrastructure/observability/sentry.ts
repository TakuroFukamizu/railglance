import type { TelemetryConfig } from '../../config/telemetry-config';
import type { TelemetrySink } from '../telemetry/sinks';
import type { StateTransitionTelemetryEvent, TelemetryEvent } from '../telemetry/types';

let initialized = false;
let sentry: typeof import('@sentry/browser') | null = null;

const LOCATION_KEYS = new Set(['latitude', 'longitude', 'lat', 'lon', 'rawLocation', 'location']);

function scrubLocation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubLocation);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !LOCATION_KEYS.has(key))
      .map(([key, child]) => [key, scrubLocation(child)])
  );
}

export async function initializeSentry(config: TelemetryConfig, telemetrySessionId: string): Promise<boolean> {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return false;

  const Sentry = await import('@sentry/browser');
  const sampleRate = Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? '0.1');
  Sentry.init({
    dsn,
    release: config.release,
    environment: config.environment,
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: Number.isFinite(sampleRate) ? Math.max(0, Math.min(sampleRate, 0.1)) : 0.1,
    beforeSend(event) {
      return scrubLocation(event) as typeof event;
    },
  });
  Sentry.setTag('telemetry.session_id', telemetrySessionId);
  if (config.datasetVersion) Sentry.setTag('railglance.dataset_version', config.datasetVersion);
  Sentry.setTag('railglance.even_sdk_version', config.evenSdkVersion);
  Sentry.setContext('railglance', { telemetrySessionId });
  sentry = Sentry;
  initialized = true;
  return true;
}

export function captureRuntimeError(
  error: unknown,
  category: string,
  context: Record<string, unknown> = {}
): void {
  const Sentry = sentry;
  if (!initialized || !Sentry) return;
  Sentry.withScope((scope) => {
    scope.setTag('railglance.error_category', category);
    scope.setContext('railglance.error', scrubLocation(context) as Record<string, unknown>);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}

export function addRuntimeBreadcrumb(
  category: string,
  message: string,
  data: Record<string, unknown> = {},
  level: 'debug' | 'info' | 'warning' | 'error' = 'info'
): void {
  const Sentry = sentry;
  if (!initialized || !Sentry) return;
  Sentry.addBreadcrumb({ category, message, data: scrubLocation(data) as Record<string, unknown>, level });
}

export class SentryTelemetrySink implements TelemetrySink {
  public write(event: TelemetryEvent): void {
    if (!initialized || event.type !== 'state-transition') return;
    this.addTransition(event);
  }

  public async flush(): Promise<void> {
    if (initialized && sentry) await sentry.flush(2_000);
  }

  public async shutdown(): Promise<void> {
    if (initialized && sentry) await sentry.close(2_000);
  }

  private addTransition(event: StateTransitionTelemetryEvent): void {
    const Sentry = sentry;
    if (!Sentry) return;
    Sentry.addBreadcrumb({
      category: `railglance.${event.category}`,
      message: event.message,
      level: event.category === 'bridge' && event.data.connected === false ? 'warning' : 'info',
      timestamp: event.timestampMs / 1000,
      data: scrubLocation(event.data) as Record<string, unknown>,
    });

    if (event.category === 'navigation' || event.category === 'route' || event.category === 'segment') {
      Sentry.setContext('railglance.navigation', scrubLocation(event.data) as Record<string, unknown>);
    }
  }
}

export const __testing = { scrubLocation };
