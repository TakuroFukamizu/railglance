import './index.css';
import { bootstrapApp } from './app/bootstrap';
import { DebugPanel } from './ui/debug-panel';
import { LocationSample } from './domain/models/location';
import { LocationProvider, BrowserLocationProvider } from './infrastructure/geolocation/browser-location-provider';
import { DeviceMotionSensorFusionProvider } from './infrastructure/sensors/device-motion-sensor-fusion-provider';
import { HudViewModel } from './domain/models/hud';
import { captureRuntimeError } from './infrastructure/observability/sentry';
import type { DiagnosticStatus } from './infrastructure/telemetry/runtime-telemetry';
import { DEFAULT_TRACKING_CONFIG } from './config/tracking-config';
import { formatBuildInfo, readBuildInfo } from './config/build-info';

class DemoGpsReplayerProvider implements LocationProvider {
  private listener: ((sample: LocationSample) => void) | null = null;
  private intervalId: any = null;

  constructor(
    private demoPoints: Array<{ lat: number; lon: number; speedKmh: number; heading: number }>
  ) {}

  public start(onLocation: (sample: LocationSample) => void): void {
    this.listener = onLocation;
    let idx = 0;
    this.intervalId = setInterval(() => {
      if (!this.listener) return;
      const pt = this.demoPoints[idx % this.demoPoints.length];
      const sample: LocationSample = {
        latitude: pt.lat,
        longitude: pt.lon,
        accuracyMeters: 10,
        speedMps: pt.speedKmh / 3.6,
        headingDegrees: pt.heading,
        timestampMs: Date.now(),
      };
      this.listener(sample);
      idx++;
    }, 1000);
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// Demo Route 1: Odakyu Line (Ebina -> Zama -> Sobudaimae)
const ODAKYU_DEMO_POINTS = [
  { lat: 35.4526, lon: 139.3900, speedKmh: 0, heading: 30 },   // Ebina station
  { lat: 35.4560, lon: 139.3915, speedKmh: 45, heading: 32 },  // Accelerating
  { lat: 35.4660, lon: 139.3950, speedKmh: 85, heading: 35 },  // Cruising
  { lat: 35.4750, lon: 139.3985, speedKmh: 93, heading: 35 },  // Near Zama
  { lat: 35.4806, lon: 139.4005, speedKmh: 20, heading: 40 },  // Zama station
  { lat: 35.4900, lon: 139.4070, speedKmh: 90, heading: 45 },  // Heading to Sobudaimae
  { lat: 35.4988, lon: 139.4144, speedKmh: 0, heading: 45 },   // Sobudaimae station
];

// Demo Route 2: Tohoku Shinkansen (Tokyo -> Ueno -> Omiya -> Utsunomiya -> Sendai)
const SHINKANSEN_DEMO_POINTS = [
  { lat: 35.6812, lon: 139.7671, speedKmh: 0, heading: 20 },   // Tokyo Station
  { lat: 35.6980, lon: 139.7730, speedKmh: 70, heading: 25 },  // Accelerating towards Ueno
  { lat: 35.7141, lon: 139.7774, speedKmh: 40, heading: 25 },  // Ueno Station
  { lat: 35.8100, lon: 139.6800, speedKmh: 210, heading: 330 },// High speed to Omiya
  { lat: 35.9063, lon: 139.6240, speedKmh: 110, heading: 330 },// Omiya Station
  { lat: 36.1000, lon: 139.7200, speedKmh: 275, heading: 20 }, // High speed Shinkansen cruise
  { lat: 36.3129, lon: 139.8066, speedKmh: 290, heading: 25 }, // Oyama
  { lat: 36.5590, lon: 139.8983, speedKmh: 315, heading: 25 }, // Utsunomiya (Max Speed 315 km/h)
  { lat: 37.3980, lon: 140.3881, speedKmh: 300, heading: 35 }, // Koriyama
  { lat: 38.2601, lon: 140.8824, speedKmh: 0, heading: 35 },   // Sendai Station
];

function updateViewportDOM(model: HudViewModel): void {
  const lineNameEl = document.getElementById('hud-line-name');
  const serviceEl = document.getElementById('hud-service');
  const speedValEl = document.getElementById('hud-speed-val');
  const speedEstEl = document.getElementById('hud-speed-est');
  const prevStationEl = document.getElementById('hud-prev-station');
  const progressTextEl = document.getElementById('hud-progress-text');
  const nextStationEl = document.getElementById('hud-next-station');
  const distNextEl = document.getElementById('hud-dist-next');
  const footerRightEl = document.getElementById('hud-footer-right');

  if (lineNameEl) lineNameEl.textContent = model.header.lineName;
  if (serviceEl) serviceEl.textContent = model.header.serviceOrDirection;
  if (speedValEl) speedValEl.textContent = model.speed.displaySpeedKmhText;
  if (speedEstEl) speedEstEl.style.display = model.speed.isEstimated ? 'inline' : 'none';

  if (prevStationEl) prevStationEl.textContent = model.segment.previousStationName;
  if (nextStationEl) nextStationEl.textContent = model.segment.nextStationName;

  if (progressTextEl) {
    if (model.segment.progressRatio !== null) {
      const totalChars = 9;
      const dotIdx = Math.max(0, Math.min(totalChars - 1, Math.round(model.segment.progressRatio * (totalChars - 1))));
      const leftBar = '━'.repeat(dotIdx);
      const rightBar = '━'.repeat(totalChars - 1 - dotIdx);
      progressTextEl.textContent = `${leftBar}●${rightBar}`;
    } else {
      progressTextEl.textContent = '━━━━━━━━━';
    }
  }

  if (distNextEl) distNextEl.textContent = model.segment.distanceToNextText;
  if (footerRightEl) footerRightEl.textContent = model.footer.statusRight;
}

function renderBuildInfo(): void {
  const el = document.getElementById('build-info');
  if (el) el.textContent = formatBuildInfo(readBuildInfo());
}

async function init() {
  // Rendered before any await so the stamp is visible even when bootstrap fails.
  renderBuildInfo();

  const debugPanel = new DebugPanel('debug-panel');
  const motionSensorProvider = new DeviceMotionSensorFusionProvider();

  const { controller, db, evenG2Adapter, logger, telemetryManager } = await bootstrapApp(undefined, (_formattedText, model) => {
    if (model) {
      updateViewportDOM(model);
    }
  });

  const routeCandidateList = document.getElementById('route-candidate-list');
  const routeCandidates = document.getElementById('route-candidates');
  const unlockRouteButton = document.getElementById('btn-unlock-route') as HTMLButtonElement | null;
  const routeLockWarning = document.getElementById('route-lock-warning');

  const renderRouteControls = () => {
    const match = controller.getCurrentRouteMatch();
    const lockState = match?.lockState ?? 'UNRESOLVED';
    if (unlockRouteButton) unlockRouteButton.hidden = lockState !== 'MANUAL_LOCK';
    if (routeLockWarning) routeLockWarning.hidden = !(lockState === 'MANUAL_LOCK' && match?.manualLockAway);

    const candidates = match?.candidates ?? [];
    const showCandidates =
      lockState === 'REACQUIRING' ||
      lockState === 'UNRESOLVED' ||
      (typeof match?.scoreMargin === 'number' &&
        match.scoreMargin < DEFAULT_TRACKING_CONFIG.routeCandidateTieMargin &&
        candidates.length > 1);
    if (routeCandidates) routeCandidates.hidden = !showCandidates || candidates.length === 0;
    if (routeCandidateList) {
      routeCandidateList.replaceChildren();
      for (const candidate of candidates) {
        const percent = Math.max(0, Math.min(100, Math.round(candidate.totalScore)));
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'route-candidate-button';
        button.dataset.segmentId = candidate.segment.id;
        const name = document.createElement('strong');
        name.textContent = candidate.line.name;
        const detail = document.createElement('small');
        detail.textContent = `${percent}% · ${candidate.distanceMeters}m · ${candidate.segment.id}`;
        button.append(name, detail);
        item.append(button);
        routeCandidateList.append(item);
      }
    }
  };

  logger.subscribe((entry) => {
    const lastImageResult = evenG2Adapter.getLastImageResult ? evenG2Adapter.getLastImageResult() : 'none';
    const syncStatus = db.getSyncStatus ? db.getSyncStatus() : undefined;
    debugPanel.update(entry, lastImageResult, syncStatus);
    renderRouteControls();
  });

  document.getElementById('btn-reacquire-route')?.addEventListener('click', () => {
    void controller.startManualReacquire();
  });

  document.getElementById('btn-unlock-route')?.addEventListener('click', () => {
    void controller.unlockManualRoute();
  });

  routeCandidateList?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('button[data-segment-id]');
    if (!button?.dataset.segmentId) return;
    void controller.lockSelectedRoute(button.dataset.segmentId);
  });

  document.getElementById('btn-start')?.addEventListener('click', () => {
    void controller.switchLocationProvider(new BrowserLocationProvider());
  });

  document.getElementById('btn-stop')?.addEventListener('click', () => {
    controller.stop();
  });

  document.getElementById('btn-request-motion')?.addEventListener('click', async () => {
    const isGranted = await motionSensorProvider.requestPermission();
    if (isGranted) {
      alert('✓ モーションセンサー有効化完了！（加速度データを受信中）');
    } else {
      const status = motionSensorProvider.getPermissionStatus();
      alert(`モーションセンサー有効化状態: ${status}\n（一度OKを押された場合、バックグラウンドで自動的にセンサーデータを受信している可能性があります）`);
    }
  });

  document.getElementById('btn-replay-odakyu')?.addEventListener('click', () => {
    void controller.switchLocationProvider(new DemoGpsReplayerProvider(ODAKYU_DEMO_POINTS));
  });

  document.getElementById('btn-replay-shinkansen')?.addEventListener('click', () => {
    void controller.switchLocationProvider(new DemoGpsReplayerProvider(SHINKANSEN_DEMO_POINTS));
  });

  const diagnosticConsent = document.getElementById('diagnostic-consent') as HTMLInputElement | null;
  const diagnosticAccessCode = document.getElementById('diagnostic-access-code') as HTMLInputElement | null;
  const diagnosticStart = document.getElementById('btn-diagnostic-start') as HTMLButtonElement | null;
  const diagnosticStop = document.getElementById('btn-diagnostic-stop') as HTMLButtonElement | null;
  const diagnosticDelete = document.getElementById('btn-diagnostic-delete') as HTMLButtonElement | null;
  const diagnosticIndicator = document.getElementById('diagnostic-indicator');
  const diagnosticStatus = document.getElementById('diagnostic-status');
  const diagnosticDetail = document.getElementById('diagnostic-detail');

  const renderDiagnosticStatus = (status: DiagnosticStatus) => {
    const collecting = ['active', 'refreshing', 'offline-buffering'].includes(status.state);
    const canResume = status.state === 'paused';
    diagnosticIndicator?.classList.toggle('is-active', collecting);
    diagnosticIndicator?.classList.toggle(
      'is-error', ['expired', 'revoked', 'release-blocked'].includes(status.state)
    );
    if (diagnosticStatus) {
      diagnosticStatus.textContent = collecting
        ? status.state === 'offline-buffering' ? '診断収集: 端末保存中' : '診断収集: 有効'
        : status.state === 'paused' ? '診断収集: 一時停止' : '診断収集: 停止';
    }
    if (diagnosticDetail) {
      const qualification = status.qualificationExpiresAt
        ? ` 資格期限: ${new Date(status.qualificationExpiresAt).toLocaleString()}`
        : '';
      diagnosticDetail.textContent = `${status.message}${qualification}`;
    }
    if (diagnosticStart) {
      diagnosticStart.disabled = collecting || ['joining', 'revoked', 'release-blocked'].includes(status.state);
      diagnosticStart.textContent = canResume ? '診断収集を再開' : '参加して診断収集を開始';
    }
    if (diagnosticStop) diagnosticStop.disabled = !collecting;
    if (diagnosticAccessCode) diagnosticAccessCode.disabled = telemetryManager.hasQualification();
    if (diagnosticConsent) diagnosticConsent.disabled = telemetryManager.hasQualification();
  };

  telemetryManager.subscribe(renderDiagnosticStatus);

  diagnosticStart?.addEventListener('click', async () => {
    if (!telemetryManager.hasQualification() && !diagnosticConsent?.checked) {
      if (diagnosticDetail) diagnosticDetail.textContent = '収集内容を確認し、同意欄をチェックしてください。';
      diagnosticIndicator?.classList.add('is-error');
      return;
    }
    diagnosticStart.disabled = true;
    try {
      await telemetryManager.startDiagnostic(diagnosticAccessCode?.value ?? '');
      if (diagnosticAccessCode) diagnosticAccessCode.value = '';
    } catch (error) {
      diagnosticStart.disabled = false;
      diagnosticIndicator?.classList.add('is-error');
      if (diagnosticDetail) diagnosticDetail.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  diagnosticStop?.addEventListener('click', async () => {
    diagnosticStop.disabled = true;
    try {
      await telemetryManager.stopDiagnostic();
    } catch (error) {
      diagnosticIndicator?.classList.add('is-error');
      if (diagnosticDetail) diagnosticDetail.textContent = '停止処理に失敗しました。未送信ログは端末に保持されています。';
      captureRuntimeError(error, 'diagnostic-session-stop');
    }
  });

  diagnosticDelete?.addEventListener('click', async () => {
    if (!window.confirm('端末内の未送信診断ログを削除します。キャンペーン参加資格は削除されません。よろしいですか？')) return;
    diagnosticDelete.disabled = true;
    try {
      await telemetryManager.deleteLocalData();
    } catch (error) {
      diagnosticIndicator?.classList.add('is-error');
      if (diagnosticDetail) diagnosticDetail.textContent = '端末内ログを削除できませんでした。';
      captureRuntimeError(error, 'diagnostic-local-data-delete');
    } finally {
      diagnosticDelete.disabled = false;
    }
  });

  // Auto-start controller and Even G2 Bridge connection
  await controller.start();
}

init().catch((error) => {
  captureRuntimeError(error, 'app-initialization');
  console.error(error);
});
