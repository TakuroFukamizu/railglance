import './index.css';
import { bootstrapApp } from './app/bootstrap';
import { DebugPanel } from './ui/debug-panel';
import { LocationSample } from './domain/models/location';
import { LocationProvider, BrowserLocationProvider } from './infrastructure/geolocation/browser-location-provider';
import { DeviceMotionSensorFusionProvider } from './infrastructure/sensors/device-motion-sensor-fusion-provider';
import { HudViewModel } from './domain/models/hud';
import { captureRuntimeError } from './infrastructure/observability/sentry';
import type { DiagnosticStatus } from './infrastructure/telemetry/runtime-telemetry';
import { buildDiagnosticPanelView } from './ui/diagnostic-panel';
import { DEFAULT_TRACKING_CONFIG } from './config/tracking-config';
import { formatBuildInfo, readBuildInfo } from './config/build-info';
import type { DatasetSyncStatus } from './infrastructure/storage/dexie-railway-database';
import { createRouter, VIEW_NAMES, type ViewElement, type ViewName } from './ui/router';
import { buildHomeStatusView, type StatusTone } from './ui/home-status-card';
import { buildRouteCandidateItems, shouldShowRouteCandidates } from './ui/route-candidates';
import { createMotionBannerController } from './ui/motion-banner';
import { attachPreviewScaler } from './ui/hud-preview-scale';
import { createDebugViewCoordinator } from './ui/debug-view';

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

const STATUS_TONES: StatusTone[] = ['ok', 'warn', 'alert'];

function renderHomeStatus(model: HudViewModel | null, sync?: DatasetSyncStatus): void {
  const view = buildHomeStatusView(model, sync);
  const lineName = document.getElementById('status-line-name');
  const direction = document.getElementById('status-direction');
  const speed = document.getElementById('status-speed');
  const right = document.getElementById('status-right');
  if (lineName) lineName.textContent = view.lineName;
  if (direction) direction.textContent = view.direction;
  if (speed) speed.textContent = view.speedText;
  if (right) {
    right.textContent = view.statusText;
    for (const tone of STATUS_TONES) right.classList.toggle(`status-${tone}`, tone === view.tone);
  }
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

  let latestModel: HudViewModel | null = null;
  const { controller, db, evenG2Adapter, logger, telemetryManager } = await bootstrapApp(undefined, (_formattedText, model) => {
    if (model) {
      latestModel = model;
      updateViewportDOM(model);
      renderHomeStatus(model, db.getSyncStatus?.());
    }
  });

  // --- Views & routing ---
  const views = Object.fromEntries(
    VIEW_NAMES.map((name) => {
      const section = document.querySelector<HTMLElement>(`[data-view="${name}"]`);
      if (!section) throw new Error(`[main] Missing view section: ${name}`);
      const heading = section.querySelector<HTMLElement>('h2');
      const element: ViewElement = {
        get hidden() {
          return section.hidden;
        },
        set hidden(value: boolean) {
          section.hidden = value;
        },
        heading: heading ? { focus: () => heading.focus({ preventScroll: true }) } : null,
      };
      return [name, element];
    })
  ) as Record<ViewName, ViewElement>;

  const backButton = document.getElementById('btn-back') as HTMLButtonElement;
  const hudRoot = document.getElementById('hud-root') as HTMLElement;
  const previewWrapper = document.getElementById('hud-preview-wrapper') as HTMLElement;
  const scaler = attachPreviewScaler({
    measureWidth: () => previewWrapper.clientWidth,
    root: hudRoot,
    requestFrame: (cb) => requestAnimationFrame(cb),
    observe:
      typeof ResizeObserver === 'function'
        ? (cb) => {
            const observer = new ResizeObserver(() => cb());
            observer.observe(previewWrapper);
            return () => observer.disconnect();
          }
        : undefined,
  });
  const debugView = createDebugViewCoordinator({ panel: debugPanel, scaler });

  const router = createRouter({
    location: window.location,
    history: window.history,
    window,
    views,
    chrome: {
      backButton,
      setTitle: (title) => {
        document.title = title;
      },
      scrollToTop: () => window.scrollTo(0, 0),
    },
    onRouteApplied: (route) => debugView.onRouteApplied(route),
  });
  backButton.addEventListener('click', () => router.navigate('home'));
  router.start();

  // The fixed diagnostic chip grows with its detail text; keep the page padding
  // large enough that the last control on every view stays reachable above it.
  const diagnosticChip = document.getElementById('diagnostic-indicator');
  diagnosticChip?.addEventListener('click', () => router.navigate('diagnostics'));
  const reserveChipSpace = () => {
    if (!diagnosticChip) return;
    const height = diagnosticChip.offsetHeight;
    if (height > 0) document.body.style.setProperty('--chip-reserve', `${height + 24}px`);
  };
  if (typeof ResizeObserver === 'function' && diagnosticChip) {
    new ResizeObserver(reserveChipSpace).observe(diagnosticChip);
  } else {
    window.addEventListener('resize', reserveChipSpace);
  }
  reserveChipSpace();

  // --- Route re-detection ---
  const routeCandidateList = document.getElementById('route-candidate-list');
  const routeCandidates = document.getElementById('route-candidates');
  const unlockRouteButton = document.getElementById('btn-unlock-route') as HTMLButtonElement | null;
  const routeLockWarning = document.getElementById('route-lock-warning');

  const renderRouteControls = () => {
    const match = controller.getCurrentRouteMatch();
    const lockState = match?.lockState ?? 'UNRESOLVED';
    if (unlockRouteButton) unlockRouteButton.hidden = lockState !== 'MANUAL_LOCK';
    if (routeLockWarning) routeLockWarning.hidden = !(lockState === 'MANUAL_LOCK' && match?.manualLockAway);

    const show = shouldShowRouteCandidates(match, DEFAULT_TRACKING_CONFIG.routeCandidateTieMargin);
    if (routeCandidates) routeCandidates.hidden = !show;
    if (routeCandidateList) {
      routeCandidateList.replaceChildren();
      for (const item of buildRouteCandidateItems(match)) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'route-candidate-button';
        button.dataset.segmentId = item.segmentId;
        const name = document.createElement('strong');
        name.textContent = item.lineName;
        const detail = document.createElement('small');
        detail.textContent = item.detail;
        button.append(name, detail);
        li.append(button);
        routeCandidateList.append(li);
      }
    }
  };

  logger.subscribe((entry) => {
    const lastImageResult = evenG2Adapter.getLastImageResult ? evenG2Adapter.getLastImageResult() : 'none';
    const syncStatus = db.getSyncStatus ? db.getSyncStatus() : undefined;
    const bridge = evenG2Adapter.getBridgeDiagnostics?.();
    debugPanel.update(entry, lastImageResult, syncStatus, bridge);
    renderRouteControls();
    renderHomeStatus(latestModel, syncStatus);
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

  // --- Motion sensor banner ---
  const motionBanner = document.getElementById('motion-banner') as HTMLElement | null;
  const motionBannerMessage = document.getElementById('motion-banner-message');
  const motionBannerButton = document.getElementById('btn-motion-banner') as HTMLButtonElement | null;
  const motionController = createMotionBannerController({ provider: motionSensorProvider });
  const renderMotionBanner = () => {
    const view = motionController.getView();
    if (motionBanner) motionBanner.hidden = !view.visible;
    if (motionBannerMessage) motionBannerMessage.textContent = view.message;
    if (motionBannerButton) {
      motionBannerButton.hidden = view.buttonLabel === null;
      motionBannerButton.textContent = view.buttonLabel ?? '';
      motionBannerButton.disabled = view.buttonDisabled;
    }
  };
  motionController.subscribe(renderMotionBanner);
  motionBannerButton?.addEventListener('click', () => void motionController.request());
  renderMotionBanner();

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
    const view = buildDiagnosticPanelView(status);
    diagnosticIndicator?.classList.toggle('is-active', view.collecting);
    diagnosticIndicator?.classList.toggle('is-error', view.errored);
    if (diagnosticStatus) diagnosticStatus.textContent = view.statusLabel;
    if (diagnosticDetail) diagnosticDetail.textContent = view.detailText;
    if (diagnosticStart) {
      diagnosticStart.disabled = view.startDisabled;
      diagnosticStart.textContent = view.startLabel;
    }
    if (diagnosticStop) diagnosticStop.disabled = view.stopDisabled;
    if (diagnosticAccessCode) {
      diagnosticAccessCode.disabled = view.accessCodeDisabled;
      diagnosticAccessCode.placeholder = view.accessCodePlaceholder;
      if (view.accessCodeDisabled) diagnosticAccessCode.value = '';
    }
    if (diagnosticConsent) {
      diagnosticConsent.disabled = view.consentDisabled;
      if (view.consentChecked !== null) diagnosticConsent.checked = view.consentChecked;
    }
  };

  telemetryManager.subscribe((status) => {
    renderDiagnosticStatus(status);
    reserveChipSpace();
  });

  diagnosticStart?.addEventListener('click', async () => {
    if (!telemetryManager.hasQualification() && !diagnosticConsent?.checked) {
      if (diagnosticDetail) diagnosticDetail.textContent = '収集内容を確認し、同意欄をチェックしてください。';
      diagnosticIndicator?.classList.add('is-error');
      return;
    }
    diagnosticStart.disabled = true;
    try {
      await telemetryManager.startDiagnostic(diagnosticAccessCode?.value ?? '');
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
