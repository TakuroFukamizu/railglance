export type TelemetryConfig = {
  endpoint: string | null;
  release: string;
  environment: string;
  datasetVersion: string | null;
  evenSdkVersion: string;
  batchSize: number;
  flushIntervalMs: number;
  maxStoredEvents: number;
  maxAgeMs: number;
};

type ViteEnvironment = Record<string, string | undefined>;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function readTelemetryConfig(env?: ViteEnvironment): TelemetryConfig {
  const source = env ?? {
    VITE_TELEMETRY_ENDPOINT: import.meta.env.VITE_TELEMETRY_ENDPOINT,
    VITE_APP_RELEASE: import.meta.env.VITE_APP_RELEASE,
    VITE_APP_ENVIRONMENT: import.meta.env.VITE_APP_ENVIRONMENT,
    VITE_RAILWAY_DATASET_VERSION: import.meta.env.VITE_RAILWAY_DATASET_VERSION,
    VITE_EVEN_SDK_VERSION: import.meta.env.VITE_EVEN_SDK_VERSION,
    VITE_TELEMETRY_BATCH_SIZE: import.meta.env.VITE_TELEMETRY_BATCH_SIZE,
    VITE_TELEMETRY_FLUSH_INTERVAL_MS: import.meta.env.VITE_TELEMETRY_FLUSH_INTERVAL_MS,
    VITE_TELEMETRY_MAX_STORED_EVENTS: import.meta.env.VITE_TELEMETRY_MAX_STORED_EVENTS,
    VITE_TELEMETRY_MAX_AGE_MS: import.meta.env.VITE_TELEMETRY_MAX_AGE_MS,
  };
  return {
    endpoint: optionalString(source.VITE_TELEMETRY_ENDPOINT)?.replace(/\/+$/, '') ?? null,
    release: optionalString(source.VITE_APP_RELEASE) ?? 'railglance@development',
    environment: optionalString(source.VITE_APP_ENVIRONMENT) ?? 'development',
    datasetVersion: optionalString(source.VITE_RAILWAY_DATASET_VERSION),
    evenSdkVersion: optionalString(source.VITE_EVEN_SDK_VERSION) ?? '0.0.12',
    batchSize: Math.min(parsePositiveInteger(source.VITE_TELEMETRY_BATCH_SIZE, 100), 200),
    flushIntervalMs: Math.max(parsePositiveInteger(source.VITE_TELEMETRY_FLUSH_INTERVAL_MS, 20_000), 5_000),
    maxStoredEvents: Math.max(parsePositiveInteger(source.VITE_TELEMETRY_MAX_STORED_EVENTS, 50_000), 200),
    maxAgeMs: Math.max(parsePositiveInteger(source.VITE_TELEMETRY_MAX_AGE_MS, 259_200_000), 60_000),
  };
}

export function createTelemetrySessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
