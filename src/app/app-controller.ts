import { TrackingConfig } from '../config/tracking-config';
import { LocationSample, FullSpeedState, SpeedEstimate } from '../domain/models/location';
import { JourneyState, RouteMatch } from '../domain/models/railway';
import { HudViewModel } from '../domain/models/hud';
import { SpeedEstimator } from '../domain/speed/speed-estimator';
import { MapMatcher } from '../domain/railway/map-matcher';
import { JourneyStateEstimator } from '../domain/railway/journey-state-estimator';
import { HudRenderer } from '../infrastructure/even-g2/hud-renderer';
import { EvenG2Adapter } from '../infrastructure/even-g2/even-g2-adapter';
import { LocationProvider } from '../infrastructure/geolocation/browser-location-provider';
import { EstimationLogEntry, EstimationLogger } from '../infrastructure/logging/logger';
import { findClosestPointOnPolyline } from '../domain/geo/polyline';

export class AppController {
  private latestSample: LocationSample | null = null;
  private currentFullSpeedState: FullSpeedState;
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
    const initialUnknown: SpeedEstimate = {
      speedKmh: null,
      confidence: 0,
      source: 'unknown',
      timestamp: now,
    };
    this.currentFullSpeedState = {
      selectedEstimate: initialUnknown,
      smoothedSpeedKmh: null,
      isStopped: false,
      isValid: false,
      candidates: {
        osSpeed: null,
        positionDeltaSpeed: null,
        trackDistanceSpeed: null,
        sensorFusionSpeed: null,
      },
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
    this.currentViewModel = this.hudRenderer.createViewModel(this.currentFullSpeedState, this.currentJourney, now);
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    await this.evenG2Adapter.connect();

    this.locationProvider.start(
      (sample) => this.onLocationUpdate(sample),
      (err) => this.onLocationError(err)
    );

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

  public async onLocationUpdate(sample: LocationSample): Promise<void> {
    this.latestSample = sample;

    // 1. Perform map matching
    this.currentMatch = await this.mapMatcher.match(sample);

    // 2. Compute track distance progress if match is valid
    let trackProgress: { distanceAlongPolylineMeters: number; timestampMs: number } | undefined;
    if (this.currentMatch) {
      const closest = findClosestPointOnPolyline(
        sample.latitude,
        sample.longitude,
        this.currentMatch.selectedSegment.coordinates
      );
      trackProgress = {
        distanceAlongPolylineMeters: closest.distanceAlongPolylineMeters,
        timestampMs: sample.timestampMs,
      };
    }

    // 3. Multi-source speed estimation & SpeedSelector
    this.currentFullSpeedState = this.speedEstimator.update(sample, trackProgress);

    // 4. Estimate journey state
    this.currentJourney = await this.journeyEstimator.update(sample, this.currentMatch, this.currentFullSpeedState);
  }

  private onLocationError(err: GeolocationPositionError): void {
    console.warn('[AppController] Location error:', err.message);
    const now = Date.now();
    const unknownEstimate: SpeedEstimate = {
      speedKmh: null,
      confidence: 0,
      source: 'unknown',
      timestamp: now,
    };
    this.currentFullSpeedState = {
      selectedEstimate: unknownEstimate,
      smoothedSpeedKmh: null,
      isStopped: false,
      isValid: false,
      candidates: {
        osSpeed: null,
        positionDeltaSpeed: null,
        trackDistanceSpeed: null,
        sensorFusionSpeed: null,
      },
    };
    this.currentJourney.status = 'GPS_UNAVAILABLE';
  }

  private async onRenderTick(): Promise<void> {
    const now = Date.now();

    if (this.latestSample && now - this.latestSample.timestampMs > this.config.staleLocationMs) {
      this.currentFullSpeedState = this.speedEstimator.getEstimateAt(now);
      if (!this.currentFullSpeedState.isValid) {
        this.currentJourney.status = 'GPS_UNAVAILABLE';
      }
    }

    this.currentViewModel = this.hudRenderer.createViewModel(
      this.currentFullSpeedState,
      this.currentJourney,
      now
    );

    await this.evenG2Adapter.render(this.currentViewModel);

    const logEntry: EstimationLogEntry = {
      timestampMs: now,
      rawLocation: this.latestSample,
      speedState: this.currentFullSpeedState,
      match: this.currentMatch,
      journey: this.currentJourney,
      hudViewModel: this.currentViewModel,
    };
    this.logger.log(logEntry);
  }
}
