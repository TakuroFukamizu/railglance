import './index.css';
import { bootstrapApp } from './app/bootstrap';
import { DebugPanel } from './ui/debug-panel';
import { LocationSample } from './domain/models/location';
import { LocationProvider, BrowserLocationProvider } from './infrastructure/geolocation/browser-location-provider';
import { DeviceMotionSensorFusionProvider } from './infrastructure/sensors/device-motion-sensor-fusion-provider';
import { HudViewModel } from './domain/models/hud';

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

async function init() {
  const debugPanel = new DebugPanel('debug-panel');
  const motionSensorProvider = new DeviceMotionSensorFusionProvider();

  const { controller, evenG2Adapter, logger } = await bootstrapApp(undefined, (_formattedText, model) => {
    if (model) {
      updateViewportDOM(model);
    }
  });

  logger.subscribe((entry) => {
    const lastImageResult = evenG2Adapter.getLastImageResult ? evenG2Adapter.getLastImageResult() : 'none';
    debugPanel.update(entry, lastImageResult);
  });

  document.getElementById('btn-start')?.addEventListener('click', () => {
    controller.switchLocationProvider(new BrowserLocationProvider());
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
    controller.switchLocationProvider(new DemoGpsReplayerProvider(ODAKYU_DEMO_POINTS));
  });

  document.getElementById('btn-replay-shinkansen')?.addEventListener('click', () => {
    controller.switchLocationProvider(new DemoGpsReplayerProvider(SHINKANSEN_DEMO_POINTS));
  });

  // Auto-start controller and Even G2 Bridge connection
  await controller.start();
}

init().catch(console.error);
