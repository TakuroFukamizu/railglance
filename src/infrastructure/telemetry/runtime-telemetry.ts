import type { TelemetryConfig } from '../../config/telemetry-config';
import { captureRuntimeError } from '../observability/sentry';
import {
  type CampaignQualificationStore,
  IndexedDbCampaignQualificationStore,
  type StoredCampaignQualification,
} from './qualification-store';
import {
  BufferedCloudTelemetrySink,
  clearBufferedTelemetry,
  TelemetryHttpError,
  type TelemetrySink,
} from './sinks';
import { isReleaseAllowed } from './release-allowlist';
import type { TelemetryEvent, TelemetryIdentity } from './types';

const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
const TOKEN_REFRESH_RETRY_MS = 60_000;

export type DiagnosticState =
  | 'errors-only'
  | 'joining'
  | 'refreshing'
  | 'active'
  | 'offline-buffering'
  | 'paused'
  | 'expired'
  | 'revoked'
  | 'release-blocked';

export type DiagnosticStatus = {
  state: DiagnosticState;
  qualificationExpiresAt: string | null;
  uploadTokenExpiresAt: string | null;
  campaignId: string | null;
  message: string;
};

type CampaignEnrollmentResponse = {
  participantId: string;
  campaignId: string;
  campaignCredential: string;
  qualificationExpiresAt: string;
  allowedReleases: string[];
  uploadToken: string;
  uploadTokenExpiresAt: string;
};

type SessionTokenResponse = {
  token: string;
  expiresAt: string;
  qualificationExpiresAt: string;
  allowedReleases: string[];
};

class QualificationRejectedError extends Error {
  constructor(public readonly reason: 'revoked' | 'release-blocked', message: string) {
    super(message);
  }
}

export class RuntimeTelemetryManager implements TelemetrySink {
  private diagnosticSink: BufferedCloudTelemetrySink | null = null;
  private qualification: StoredCampaignQualification | null = null;
  private uploadToken: string | null = null;
  private uploadTokenExpiresAtMs = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<string> | null = null;
  private closed = false;
  private listeners = new Set<(status: DiagnosticStatus) => void>();
  private status: DiagnosticStatus = {
    state: 'errors-only',
    qualificationExpiresAt: null,
    uploadTokenExpiresAt: null,
    campaignId: null,
    message: '診断収集は停止しています。',
  };

  constructor(
    private readonly sentrySink: TelemetrySink,
    private readonly config: TelemetryConfig,
    private readonly identity: TelemetryIdentity,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly qualificationStore: CampaignQualificationStore = new IndexedDbCampaignQualificationStore()
  ) {}

  public async initialize(): Promise<DiagnosticStatus> {
    this.closed = false;
    this.qualification = await this.qualificationStore.get();
    if (!this.qualification) return this.setStatus('errors-only', '診断収集は停止しています。');
    if (Date.parse(this.qualification.qualificationExpiresAt) <= Date.now()) {
      await this.qualificationStore.clear();
      this.qualification = null;
      return this.setStatus('expired', 'キャンペーン参加資格の有効期限が切れています。未送信ログは端末に保持されています。');
    }
    if (!this.qualification.collectionEnabled) {
      return this.setStatus('paused', '診断収集は一時停止中です。参加コードなしで再開できます。');
    }

    this.ensureDiagnosticSink();
    this.setStatus('refreshing', '参加資格を確認し、送信tokenを更新しています。');
    try {
      await this.refreshUploadToken();
      void this.diagnosticSink?.flush();
    } catch (error) {
      await this.handleRefreshFailure(error);
    }
    return this.status;
  }

  public subscribe(listener: (status: DiagnosticStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  public getStatus(): DiagnosticStatus {
    return this.status;
  }

  public hasQualification(): boolean {
    return Boolean(this.qualification && Date.parse(this.qualification.qualificationExpiresAt) > Date.now());
  }

  public isDiagnosticEnabled(): boolean {
    return Boolean(
      this.qualification?.collectionEnabled &&
      Date.parse(this.qualification.qualificationExpiresAt) > Date.now() &&
      this.status.state !== 'revoked' &&
      this.status.state !== 'release-blocked'
    );
  }

  public async startDiagnostic(accessCode = ''): Promise<DiagnosticStatus> {
    if (!this.config.endpoint) throw new Error('診断テレメトリの送信先が設定されていません。');
    if (this.hasQualification()) return this.resumeDiagnostic();
    if (!accessCode.trim()) throw new Error('初回参加用のキャンペーンコードを入力してください。');

    this.setStatus('joining', 'キャンペーン参加資格を登録しています。');
    const response = await this.fetchFn(`${this.config.endpoint}/v1/telemetry/campaign/enroll`, {
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
      this.setStatus('errors-only', 'キャンペーンへ参加できませんでした。');
      throw new Error(response.status === 401
        ? 'キャンペーンコードを確認してください。'
        : response.status === 429
          ? '参加試行回数の上限に達しました。時間をおいてください。'
          : `キャンペーンへ参加できませんでした (HTTP ${response.status})。`);
    }

    const result = await response.json() as Partial<CampaignEnrollmentResponse>;
    this.validateEnrollment(result);
    const qualification: StoredCampaignQualification = {
      key: 'active',
      schemaVersion: 1,
      participantId: result.participantId,
      campaignId: result.campaignId,
      credential: result.campaignCredential,
      qualificationExpiresAt: result.qualificationExpiresAt,
      allowedReleases: result.allowedReleases,
      consentedAt: new Date().toISOString(),
      collectionEnabled: true,
      lastValidatedRelease: this.identity.release,
    };
    await this.qualificationStore.set(qualification);
    this.qualification = qualification;
    this.setUploadToken(result.uploadToken, result.uploadTokenExpiresAt);
    this.ensureDiagnosticSink();
    return this.setStatus('active', '診断収集中です。送信tokenは自動更新されます。');
  }

  public async resumeDiagnostic(): Promise<DiagnosticStatus> {
    const qualification = this.qualification;
    if (!qualification || Date.parse(qualification.qualificationExpiresAt) <= Date.now()) {
      throw new Error('有効なキャンペーン参加資格がありません。');
    }
    qualification.collectionEnabled = true;
    await this.qualificationStore.set(qualification);
    this.ensureDiagnosticSink();
    this.setStatus('refreshing', '参加資格を確認しています。');
    try {
      await this.refreshUploadToken(true);
      void this.diagnosticSink?.flush();
      return this.status;
    } catch (error) {
      await this.handleRefreshFailure(error);
      if (error instanceof QualificationRejectedError) throw error;
      return this.status;
    }
  }

  public async stopDiagnostic(): Promise<DiagnosticStatus> {
    this.clearRefreshTimer();
    if (this.qualification) {
      this.qualification.collectionEnabled = false;
      await this.qualificationStore.set(this.qualification);
    }
    const sink = this.diagnosticSink;
    this.diagnosticSink = null;
    await sink?.close(false);
    this.uploadToken = null;
    this.uploadTokenExpiresAtMs = 0;
    return this.setStatus('paused', '診断収集を一時停止しました。参加資格と未送信ログは保持されています。');
  }

  public async deleteLocalData(): Promise<DiagnosticStatus> {
    const wasEnabled = this.isDiagnosticEnabled();
    const sink = this.diagnosticSink;
    this.diagnosticSink = null;
    await sink?.close(false);
    await clearBufferedTelemetry();
    if (wasEnabled) this.ensureDiagnosticSink();
    return this.setStatus(
      this.status.state,
      wasEnabled ? '端末内の未送信ログを削除しました。診断収集は継続中です。' : '端末内の未送信ログを削除しました。'
    );
  }

  public write(event: TelemetryEvent): void {
    this.sentrySink.write(event);
    if (this.isDiagnosticEnabled()) this.diagnosticSink?.write(event);
  }

  public async flush(): Promise<void> {
    await Promise.allSettled([this.sentrySink.flush(), this.diagnosticSink?.flush()]);
  }

  public async shutdown(): Promise<void> {
    this.closed = true;
    this.clearRefreshTimer();
    const sink = this.diagnosticSink;
    this.diagnosticSink = null;
    await Promise.allSettled([this.sentrySink.shutdown(), sink?.close(true)]);
    this.qualificationStore.close();
  }

  private ensureDiagnosticSink(): void {
    if (this.diagnosticSink || !this.config.endpoint) return;
    this.diagnosticSink = new BufferedCloudTelemetrySink({
      endpoint: this.config.endpoint,
      getUploadToken: () => this.getUploadToken(),
      batchSize: this.config.batchSize,
      flushIntervalMs: this.config.flushIntervalMs,
      maxStoredEvents: this.config.maxStoredEvents,
      maxAgeMs: this.config.maxAgeMs,
      fetchFn: this.fetchFn,
      onError: (error) => {
        captureRuntimeError(error, 'telemetry-buffer-or-upload');
        if (error instanceof TelemetryHttpError && (error.status === 401 || error.status === 403)) {
          void this.refreshUploadToken(true).catch((refreshError) => this.handleRefreshFailure(refreshError));
        }
      },
    });
  }

  private async getUploadToken(): Promise<string> {
    if (this.uploadToken && Date.now() < this.uploadTokenExpiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return this.uploadToken;
    }
    return this.refreshUploadToken();
  }

  private refreshUploadToken(force = false): Promise<string> {
    if (!force && this.uploadToken && Date.now() < this.uploadTokenExpiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return Promise.resolve(this.uploadToken);
    }
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.requestUploadToken().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async requestUploadToken(): Promise<string> {
    const qualification = this.qualification;
    if (!qualification || !this.config.endpoint) throw new QualificationRejectedError('revoked', '参加資格がありません。');
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.endpoint}/v1/telemetry/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          campaignCredential: qualification.credential,
          release: this.identity.release,
          environment: this.identity.environment,
        }),
      });
    } catch (error) {
      this.scheduleRefresh(TOKEN_REFRESH_RETRY_MS);
      if (qualification.lastValidatedRelease === this.identity.release) {
        this.setStatus('offline-buffering', 'オフラインのため端末に保存中です。接続回復後に自動再送します。');
      } else {
        this.setStatus('release-blocked', '更新後のrelease資格をオンラインで確認するまで診断収集を停止します。');
      }
      throw error;
    }
    if (response.status === 401 || response.status === 410) {
      throw new QualificationRejectedError('revoked', 'キャンペーン参加資格が失効しました。');
    }
    if (response.status === 403) {
      throw new QualificationRejectedError('release-blocked', 'このアプリreleaseはキャンペーン対象外です。');
    }
    if (!response.ok) {
      this.scheduleRefresh(TOKEN_REFRESH_RETRY_MS);
      this.setStatus(
        qualification.lastValidatedRelease === this.identity.release ? 'offline-buffering' : 'release-blocked',
        qualification.lastValidatedRelease === this.identity.release
          ? `送信tokenを更新できないため端末に保存中です (HTTP ${response.status})。`
          : '更新後のrelease資格を確認できないため診断収集を停止しています。'
      );
      throw new Error(`Upload token refresh returned HTTP ${response.status}`);
    }
    const result = await response.json() as Partial<SessionTokenResponse>;
    const qualificationExpiresAtMs = typeof result.qualificationExpiresAt === 'string'
      ? Date.parse(result.qualificationExpiresAt)
      : NaN;
    if (
      typeof result.token !== 'string' || typeof result.expiresAt !== 'string' ||
      typeof result.qualificationExpiresAt !== 'string' || !Number.isFinite(qualificationExpiresAtMs) ||
      qualificationExpiresAtMs <= Date.now() ||
      !Array.isArray(result.allowedReleases) ||
      !result.allowedReleases.every((release) => typeof release === 'string') ||
      !isReleaseAllowed(this.identity.release, result.allowedReleases)
    ) {
      throw new Error('送信tokenの応答が不正です。');
    }
    this.setUploadToken(result.token, result.expiresAt);
    qualification.qualificationExpiresAt = result.qualificationExpiresAt;
    qualification.allowedReleases = result.allowedReleases;
    qualification.lastValidatedRelease = this.identity.release;
    await this.qualificationStore.set(qualification);
    this.setStatus('active', '診断収集中です。送信tokenは自動更新されます。');
    return result.token;
  }

  private setUploadToken(token: string, expiresAt: string): void {
    const expiresAtMs = Date.parse(expiresAt);
    if (!token || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error('送信tokenの有効期限が不正です。');
    }
    this.uploadToken = token;
    this.uploadTokenExpiresAtMs = expiresAtMs;
    this.scheduleRefresh(Math.max(30_000, expiresAtMs - Date.now() - TOKEN_REFRESH_SKEW_MS));
  }

  private async handleRefreshFailure(error: unknown): Promise<void> {
    if (!(error instanceof QualificationRejectedError)) return;
    this.clearRefreshTimer();
    this.uploadToken = null;
    this.uploadTokenExpiresAtMs = 0;
    const sink = this.diagnosticSink;
    this.diagnosticSink = null;
    await sink?.close(false);
    if (error.reason === 'revoked') {
      if (this.qualification) {
        this.qualification.collectionEnabled = false;
        await this.qualificationStore.set(this.qualification);
      }
      this.setStatus('revoked', 'キャンペーン参加資格が失効しました。未送信ログは端末に保持されています。');
    } else {
      this.setStatus('release-blocked', error.message);
    }
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.closed || !this.qualification?.collectionEnabled) return;
    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => {
      void this.refreshUploadToken(true)
        .then(() => this.diagnosticSink?.flush())
        .catch((error) => this.handleRefreshFailure(error));
    }, delayMs);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private setStatus(state: DiagnosticState, message: string): DiagnosticStatus {
    this.status = {
      state,
      qualificationExpiresAt: this.qualification?.qualificationExpiresAt ?? null,
      uploadTokenExpiresAt: this.uploadTokenExpiresAtMs > 0
        ? new Date(this.uploadTokenExpiresAtMs).toISOString()
        : null,
      campaignId: this.qualification?.campaignId ?? null,
      message,
    };
    for (const listener of this.listeners) listener(this.status);
    return this.status;
  }

  private validateEnrollment(result: Partial<CampaignEnrollmentResponse>): asserts result is CampaignEnrollmentResponse {
    const qualificationExpiresAtMs = typeof result.qualificationExpiresAt === 'string'
      ? Date.parse(result.qualificationExpiresAt)
      : NaN;
    if (
      typeof result.participantId !== 'string' || !result.participantId ||
      typeof result.campaignId !== 'string' || !result.campaignId ||
      typeof result.campaignCredential !== 'string' || !result.campaignCredential ||
      typeof result.qualificationExpiresAt !== 'string' || !Number.isFinite(qualificationExpiresAtMs) ||
      qualificationExpiresAtMs <= Date.now() ||
      !Array.isArray(result.allowedReleases) ||
      !result.allowedReleases.every((release) => typeof release === 'string') ||
      !isReleaseAllowed(this.identity.release, result.allowedReleases) ||
      typeof result.uploadToken !== 'string' || !result.uploadToken ||
      typeof result.uploadTokenExpiresAt !== 'string'
    ) throw new Error('キャンペーン参加応答が不正です。');
  }
}
