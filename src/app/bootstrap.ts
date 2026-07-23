import { DEFAULT_TRACKING_CONFIG } from '../config/tracking-config';
import { DexieRailwayDatabase } from '../infrastructure/storage/dexie-railway-database';
import { MapMatcher } from '../domain/railway/map-matcher';
import { JourneyStateEstimator } from '../domain/railway/journey-state-estimator';
import { BrowserLocationProvider, LocationProvider } from '../infrastructure/geolocation/browser-location-provider';
import { MockEvenG2Adapter } from '../infrastructure/even-g2/even-g2-adapter';
import { EstimationLogger } from '../infrastructure/logging/logger';
import { AppController } from './app-controller';
import { DebugPanel } from '../ui/debug-panel';
import { HudViewModel } from '../domain/models/hud';

export type AppBootstrapResult = {
  controller: AppController;
  db: DexieRailwayDatabase;
  logger: EstimationLogger;
};

export async function bootstrapApp(
  customLocationProvider?: LocationProvider,
  onHudRender?: (formattedText: string, model: HudViewModel) => void
): Promise<AppBootstrapResult> {
  const db = new DexieRailwayDatabase();
  await db.initialize();

  const config = DEFAULT_TRACKING_CONFIG;
  const mapMatcher = new MapMatcher(db, config);
  const journeyEstimator = new JourneyStateEstimator(db, config);

  const locationProvider = customLocationProvider ?? new BrowserLocationProvider();
  const evenG2Adapter = new MockEvenG2Adapter(onHudRender);
  const logger = new EstimationLogger();

  const controller = new AppController(
    locationProvider,
    mapMatcher,
    journeyEstimator,
    evenG2Adapter,
    logger,
    config
  );

  return {
    controller,
    db,
    logger,
  };
}
