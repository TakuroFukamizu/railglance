import { TrackingConfig } from '../config/tracking-config';
import { LocationSample, SpeedEstimate } from '../domain/models/location';
import { JourneyState, RouteMatch } from '../domain/models/railway';
import { HudViewModel } from '../domain/models/hud';
import { SpeedEstimator } from '../domain/speed/speed-estimator';
import { MapMatcher } from '../domain/railway/map-matcher';
import { JourneyStateEstimator } from '../domain/railway/journey-state-estimator';
import { HudRenderer } from '../infrastructure/even-g2/hud-renderer';
import { EvenG2Adapter } from '../infrastructure/even-g2/even-g2-adapter';
import { LocationProvider } from '../infrastructure/geolocation/browser-location-provider';
import { EstimationLogEntry, EstimationLogger } from '../infrastructure/logging/logger';

export class AppController {
  private latestSample: LocationSample | null = null;
  private currentSpeed: SpeedEstimate;
  private currentMatch: RouteMatch | null = null;
  private currentJourney: JourneyState;
  private currentViewModel: HudViewModel;

  private speedEstimator: SpeedEstimator;
  private hudRenderer: HudRenderer;
  private renderTimerId: any = null;
  private isRunning = false;

  constructor(
    private locationProvider: LocationProvider,
    private mapMatcher: MapMatcher,
    private journeyEstimator: JourneyStateEstimator,
    private evenG2Adapter: EvenG2Adapter,
    private logger: EstimationLogger,
    private config: TrackingConfig
  ) {
    this.speedEstimator = new SpeedEstimator(config);
    this.hudRenderer = new HudRenderer();

    const now = Date.now();
    this.currentSpeed = {
      speedMps: null,
      speedKmh: null,
      rawSpeedKmh: null,
      isStopped: false,
      isValid: false,
      timestampMs: now,
      source: 'unknown',
    };
    this.currentJourney = {
      line: null,
      direction: 'UNKNOWN',
      directionName: null,
      previousStation: null,
      nextStation: null,
      distanceToNextStationMeters: null,
      confidence: 0,
      status: 'INITIALIZING',
    };
    this.currentViewModel = this.hudRenderer.createViewModel(this.currentSpeed, this.currentJourney, now);
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.evenG2Adapter.connect();

    // 1. Start location provider
    this.locationProvider.start(
      (sample) => this.onLocationUpdate(sample),
      (err) => this.onLocationError(err)
    );

    // 2. Start decoupled HUD 1-second render loop
    this.renderTimerId = setInterval(() => {
      this.onRenderTick();
    }, this.config.hudRefreshMs);
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    this.locationProvider.stop();
    if (this.renderTimerId) {
      clearInterval(this.renderTimerId);
      this.renderTimerId = null;
    }
  }

  /**
   * Process incoming location samples independently of HUD render ticks.
   */
  public async onLocationUpdate(sample: LocationSample): Promise<void> {
    this.latestSample = sample;

    // 1. Update speed estimation
    this.currentSpeed = this.speedEstimator.update(sample);

    // 2. Perform map matching
    this.currentMatch = await this.mapMatcher.match(sample);

    // 3. Estimate journey state (direction, stations, distance)
    this.currentJourney = await this.journeyEstimator.update(sample, this.currentMatch, this.currentSpeed);
  }

  private onLocationError(err: GeolocationPositionError): void {
    console.warn('[AppController] Location error:', err.message);
    const now = Date.now();
    this.currentSpeed = {
      speedMps: null,
      speedKmh: null,
      rawSpeedKmh: null,
      isStopped: false,
      isValid: false,
      timestampMs: now,
      source: 'unknown',
    };
    this.currentJourney.status = 'GPS_UNAVAILABLE';
  }

  /**
   * Decoupled tick called every 1 second to update HUD.
   */
  private async onRenderTick(): Promise<void> {
    const now = Date.now();

    // Check if location is stale
    if (this.latestSample && now - this.latestSample.timestampMs > this.config.staleLocationMs) {
      this.currentSpeed = this.speedEstimator.getEstimateAt(now);
      if (!this.currentSpeed.isValid) {
        this.currentJourney.status = 'GPS_UNAVAILABLE';
      }
    }

    // Generate View Model
    this.currentViewModel = this.hudRenderer.createViewModel(
      this.currentSpeed,
      this.currentJourney,
      now
    );

    // Render to Even G2 Adapter
    await this.evenG2Adapter.render(this.currentViewModel);

    // Log estimation
    const logEntry: EstimationLogEntry = {
      timestampMs: now,
      rawLocation: this.latestSample,
      speed: this.currentSpeed,
      match: this.currentMatch,
      journey: this.currentJourney,
      hudViewModel: this.currentViewModel,
    };
    this.logger.log(logEntry);
  }
}
