import type { TelemetryConfig } from '../../config/telemetry-config';
import { captureRuntimeError } from '../observability/sentry';
import {
  BufferedCloudTelemetrySink,
  clearBufferedTelemetry,
  type TelemetrySink,
} from './sinks';
import type { TelemetryEvent, TelemetryIdentity } from './types';

export type DiagnosticSession = {
  mode: 'diagnostic';
  expiresAt: string;
};

type SessionTokenResponse = {
  token: string;
  expiresAt: string;
};

export class RuntimeTelemetryManager implements TelemetrySink {
  private diagnosticSink: BufferedCloudTelemetrySink | null = null;
  private expiresAtMs = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sentrySink: TelemetrySink,
    private readonly config: TelemetryConfig,
    private readonly identity: TelemetryIdentity,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  public async initialize(): Promise<void> {
    await clearBufferedTelemetry();
  }

  public isDiagnosticEnabled(): boolean {
    if (!this.diagnosticSink) return false;
    if (Date.now() < this.expiresAtMs) return true;
    void this.stopDiagnostic();
    return false;
  }

  public async startDiagnostic(accessCode: string): Promise<DiagnosticSession> {
    if (!this.config.endpoint) throw new Error('診断テレメトリの送信先が設定されていません。');
    if (!accessCode.trim()) throw new Error('テスターコードを入力してください。');

    await this.stopDiagnostic();
    const response = await this.fetchFn(`${this.config.endpoint}/v1/telemetry/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        sessionId: this.identity.sessionId,
        release: this.identity.release,
        environment: this.identity.environment,
        consent: true,
        accessCode: accessCode.trim(),
      }),
    });
    if (!response.ok) {
      throw new Error(response.status === 401
        ? 'テスターコードを確認してください。'
        : `診断セッションを開始できませんでした (HTTP ${response.status})。`);
    }

    const result = await response.json() as Partial<SessionTokenResponse>;
    const expiresAtMs = typeof result.expiresAt === 'string' ? Date.parse(result.expiresAt) : NaN;
    if (typeof result.token !== 'string' || !result.token || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error('診断セッションの応答が不正です。');
    }

    await clearBufferedTelemetry();
    this.expiresAtMs = expiresAtMs;
    this.diagnosticSink = new BufferedCloudTelemetrySink({
      endpoint: this.config.endpoint,
      uploadToken: result.token,
      batchSize: this.config.batchSize,
      flushIntervalMs: this.config.flushIntervalMs,
      maxStoredEvents: this.config.maxStoredEvents,
      maxAgeMs: this.config.maxAgeMs,
      fetchFn: this.fetchFn,
      onError: (error) => captureRuntimeError(error, 'telemetry-buffer-or-upload'),
    });
    this.expiryTimer = setTimeout(() => void this.stopDiagnostic(), Math.max(0, expiresAtMs - Date.now()));
    return { mode: 'diagnostic', expiresAt: new Date(expiresAtMs).toISOString() };
  }

  public async stopDiagnostic(): Promise<void> {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const sink = this.diagnosticSink;
    this.diagnosticSink = null;
    this.expiresAtMs = 0;
    try {
      await sink?.shutdown();
    } finally {
      await clearBufferedTelemetry();
    }
  }

  public write(event: TelemetryEvent): void {
    this.sentrySink.write(event);
    if (this.isDiagnosticEnabled()) this.diagnosticSink?.write(event);
  }

  public async flush(): Promise<void> {
    await Promise.allSettled([this.sentrySink.flush(), this.diagnosticSink?.flush()]);
  }

  public async shutdown(): Promise<void> {
    await Promise.allSettled([this.sentrySink.shutdown(), this.stopDiagnostic()]);
  }
}
