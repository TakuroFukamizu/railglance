import { DEFAULT_TRACKING_CONFIG } from '../config/tracking-config';
import { DexieRailwayDatabase } from '../infrastructure/storage/dexie-railway-database';
import { MapMatcher } from '../domain/railway/map-matcher';
import { JourneyStateEstimator } from '../domain/railway/journey-state-estimator';
import { LocationProvider } from '../infrastructure/geolocation/browser-location-provider';
import { AdaptiveLocationProvider } from '../infrastructure/geolocation/even-app-location-provider';
import { HybridEvenG2Adapter } from '../infrastructure/even-g2/even-g2-adapter';
import { EstimationLogger } from '../infrastructure/logging/logger';
import { AppController } from './app-controller';
import { HudViewModel } from '../domain/models/hud';
import { createTelemetrySessionId, readTelemetryConfig } from '../config/telemetry-config';
import { captureRuntimeError, initializeSentry, SentryTelemetrySink } from '../infrastructure/observability/sentry';
import { RuntimeTelemetryManager } from '../infrastructure/telemetry/runtime-telemetry';

export type AppBootstrapResult = {
  controller: AppController;
  db: DexieRailwayDatabase;
  logger: EstimationLogger;
  evenG2Adapter: HybridEvenG2Adapter;
  telemetryManager: RuntimeTelemetryManager;
};

export async function bootstrapApp(
  customLocationProvider?: LocationProvider,
  onHudRender?: (formattedText: string, model: HudViewModel, canvas?: HTMLCanvasElement | null) => void
): Promise<AppBootstrapResult> {
  const telemetryConfig = readTelemetryConfig();
  const telemetrySessionId = createTelemetrySessionId();
  await initializeSentry(telemetryConfig, telemetrySessionId);

  const telemetryIdentity = {
    sessionId: telemetrySessionId,
    release: telemetryConfig.release,
    environment: telemetryConfig.environment,
    datasetVersion: telemetryConfig.datasetVersion,
    evenSdkVersion: telemetryConfig.evenSdkVersion,
  };
  const telemetryManager = new RuntimeTelemetryManager(
    new SentryTelemetrySink(), telemetryConfig, telemetryIdentity
  );
  await telemetryManager.initialize().catch((error) => captureRuntimeError(error, 'telemetry-buffer-clear'));

  const db = new DexieRailwayDatabase();
  await db.initialize();

  const config = DEFAULT_TRACKING_CONFIG;
  const mapMatcher = new MapMatcher(db, config);
  const journeyEstimator = new JourneyStateEstimator(db, config);

  // AdaptiveLocationProvider tries Even App location first (for Prototype mode & native app), falling back to Browser Geolocation
  const locationProvider = customLocationProvider ?? new AdaptiveLocationProvider();
  const evenG2Adapter = new HybridEvenG2Adapter(onHudRender, {
    telemetry: { sink: telemetryManager, identity: telemetryIdentity },
  });
  const logger = new EstimationLogger(
    telemetryIdentity,
    telemetryManager,
    () => telemetryManager.isDiagnosticEnabled()
  );

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => void logger.flush(), { once: true });
  }

  const controller = new AppController(
    locationProvider,
    mapMatcher,
    journeyEstimator,
    db,
    evenG2Adapter,
    logger,
    config
  );

  return {
    controller,
    db,
    logger,
    evenG2Adapter,
    telemetryManager,
  };
}
