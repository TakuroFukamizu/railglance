import './index.css';
import { bootstrapApp } from './app/bootstrap';
import { DebugPanel } from './ui/debug-panel';
import { LocationSample } from './domain/models/location';
import { LocationProvider } from './infrastructure/geolocation/browser-location-provider';

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
  { lat: 35.6812, lon: 139.7671, speedKmh: 0, heading: 20 },   // Tokyo Station (stop)
  { lat: 35.6980, lon: 139.7730, speedKmh: 70, heading: 25 },  // Accelerating towards Ueno
  { lat: 35.7141, lon: 139.7774, speedKmh: 40, heading: 25 },  // Ueno Station
  { lat: 35.8100, lon: 139.6800, speedKmh: 210, heading: 330 },// High speed to Omiya
  { lat: 35.9063, lon: 139.6240, speedKmh: 110, heading: 330 },// Omiya Station
  { lat: 36.1000, lon: 139.7200, speedKmh: 275, heading: 20 }, // High speed Shinkansen cruise
  { lat: 36.3129, lon: 139.8066, speedKmh: 290, heading: 25 }, // Oyama
  { lat: 36.5590, lon: 139.8983, speedKmh: 315, heading: 25 }, // Utsunomiya (Max Speed 315 km/h)
  { lat: 37.3980, lon: 140.3881, speedKmh: 300, heading: 35 }, // Koriyama
  { lat: 38.2601, lon: 140.8824, speedKmh: 0, heading: 35 },   // Sendai Station (Arrival)
];

async function init() {
  const hudTextEl = document.getElementById('hud-text');
  const debugPanel = new DebugPanel('debug-panel');

  let currentApp = await bootstrapApp(undefined, (text) => {
    if (hudTextEl) hudTextEl.textContent = text;
  });

  currentApp.logger.subscribe((entry) => {
    debugPanel.update(entry);
  });

  document.getElementById('btn-start')?.addEventListener('click', async () => {
    currentApp.controller.stop();
    currentApp = await bootstrapApp(undefined, (text) => {
      if (hudTextEl) hudTextEl.textContent = text;
    });
    currentApp.logger.subscribe((entry) => {
      debugPanel.update(entry);
    });
    await currentApp.controller.start();
  });

  document.getElementById('btn-stop')?.addEventListener('click', () => {
    currentApp.controller.stop();
  });

  document.getElementById('btn-replay-odakyu')?.addEventListener('click', async () => {
    currentApp.controller.stop();
    const demoProvider = new DemoGpsReplayerProvider(ODAKYU_DEMO_POINTS);
    currentApp = await bootstrapApp(demoProvider, (text) => {
      if (hudTextEl) hudTextEl.textContent = text;
    });
    currentApp.logger.subscribe((entry) => {
      debugPanel.update(entry);
    });
    await currentApp.controller.start();
  });

  document.getElementById('btn-replay-shinkansen')?.addEventListener('click', async () => {
    currentApp.controller.stop();
    const demoProvider = new DemoGpsReplayerProvider(SHINKANSEN_DEMO_POINTS);
    currentApp = await bootstrapApp(demoProvider, (text) => {
      if (hudTextEl) hudTextEl.textContent = text;
    });
    currentApp.logger.subscribe((entry) => {
      debugPanel.update(entry);
    });
    await currentApp.controller.start();
  });

  // Auto-start on load
  await currentApp.controller.start();
}

init().catch(console.error);
