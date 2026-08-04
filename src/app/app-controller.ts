import { TrackingConfig } from '../config/tracking-config';
import { LocationSample, FullSpeedState, SpeedEstimate } from '../domain/models/location';
import { JourneyState, RouteMatch } from '../domain/models/railway';
import { HudViewModel } from '../domain/models/hud';
import { SpeedEstimator } from '../domain/speed/speed-estimator';
import { MapMatcher } from '../domain/railway/map-matcher';
import { JourneyStateEstimator } from '../domain/railway/journey-state-estimator';
import { RailwayDataRepository } from '../domain/railway/repository';
import { HudRenderer } from '../infrastructure/even-g2/hud-renderer';
import { EvenG2Adapter } from '../infrastructure/even-g2/even-g2-adapter';
import { LocationProvider, LocationProviderError } from '../infrastructure/geolocation/browser-location-provider';
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
  private routeMissStartedAtMs: number | null = null;
  private renderTickInFlight = false;
  private renderTickPending = false;

  constructor(
    private locationProvider: LocationProvider,
    private mapMatcher: MapMatcher,
    private journeyEstimator: JourneyStateEstimator,
    private repository: RailwayDataRepository,
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
        deadReckoningSpeed: null,
        sensorFusionSpeed: null,
      },
      navState: {
        lineId: null,
        routeId: null,
        segmentId: null,
        direction: 'UNKNOWN',
        trackPositionMeters: null,
        velocityMps: 0,
        accelerationMps2: 0,
        accelerationBiasMps2: 0,
        lastObservationTimestampMs: null,
        lastPredictionTimestampMs: now,
        mode: 'lost',
        confidence: 0.0,
      },
    };
    this.currentJourney = {
      line: null,
      direction: 'UNKNOWN',
      directionName: null,
      previousStation: null,
      nextStation: null,
      distanceToNextStationMeters: null,
      progressRatio: null,
      confidence: 0,
      status: 'INITIALIZING',
    };
    this.currentViewModel = this.hudRenderer.createViewModel(this.currentFullSpeedState, this.currentJourney, now);
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.evenG2Adapter.connect();
      await this.locationProvider.start(
        (sample) => this.onLocationUpdate(sample),
        (err) => this.onLocationError(err)
      );

      this.renderTimerId = setInterval(() => {
        void this.runRenderTick();
      }, this.config.hudRefreshMs);
    } catch (error) {
      this.isRunning = false;
      await this.locationProvider.stop();
      await this.evenG2Adapter.clear();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    await this.locationProvider.stop();
    if (this.renderTimerId) {
      clearInterval(this.renderTimerId);
      this.renderTimerId = null;
    }
    await this.evenG2Adapter.clear();
  }

  public async switchLocationProvider(newProvider: LocationProvider): Promise<void> {
    await this.locationProvider.stop();
    this.speedEstimator.reset();
    this.journeyEstimator.reset();
    this.mapMatcher.reset();
    this.routeMissStartedAtMs = null;

    this.locationProvider = newProvider;
    if (this.isRunning) {
      await this.locationProvider.start(
        (sample) => this.onLocationUpdate(sample),
        (err) => this.onLocationError(err)
      );
    }
  }

  public async onLocationUpdate(sample: LocationSample): Promise<void> {
    this.latestSample = sample;

    // 1. NON-BLOCKING: Trigger background coverage fetch (do not await, to ensure speed calculation is un-blocked)
    void this.repository.ensureCoverageAround(sample.latitude, sample.longitude).catch((err) => {
      console.warn('[AppController] Background coverage fetch notice:', err);
    });

    // 2. Perform map matching with currently available segments
    this.currentMatch = await this.mapMatcher.match(sample);

    if (this.currentMatch) {
      this.routeMissStartedAtMs = null;
    } else if (sample.accuracyMeters <= this.config.maxGpsAccuracyMeters) {
      this.routeMissStartedAtMs ??= sample.timestampMs;
      if (sample.timestampMs - this.routeMissStartedAtMs >= this.config.routeMatchLossGraceMs) {
        this.speedEstimator.getNavStateEstimator().clearRoute();
        this.journeyEstimator.invalidateRoute();
      }
    }

    // 3. Compute track distance progress if match is valid
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

    // 4. Immediate Speed Estimation (Un-blocked by network)
    this.currentFullSpeedState = this.speedEstimator.update(sample, this.currentMatch, trackProgress);

    // 5. Estimate journey state & recover status if valid GPS returned
    const currentSegment = this.speedEstimator.getNavStateEstimator().getCurrentSegment();
    this.currentJourney = await this.journeyEstimator.update(
      sample,
      this.currentMatch,
      this.currentFullSpeedState,
      this.currentFullSpeedState.navState,
      currentSegment
    );
    this.speedEstimator.getNavStateEstimator().setDirection(
      this.toNavigationDirection(this.currentJourney.direction)
    );

    if (this.currentFullSpeedState.isValid && this.currentJourney.status === 'GPS_UNAVAILABLE') {
      this.currentJourney.status = this.currentMatch ? 'TRACKING' : 'ROUTE_UNCERTAIN';
    }
  }

  private onLocationError(err: LocationProviderError): void {
    console.warn('[AppController] Location error:', err.message);
  }

  private async runRenderTick(): Promise<void> {
    if (!this.isRunning) return;
    if (this.renderTickInFlight) {
      this.renderTickPending = true;
      return;
    }
    this.renderTickInFlight = true;
    this.renderTickPending = false;
    try {
      await this.onRenderTick();
    } catch (error) {
      console.warn('[AppController] HUD render tick failed:', error);
    } finally {
      this.renderTickInFlight = false;
      if (this.renderTickPending && this.isRunning) void this.runRenderTick();
    }
  }

  private async onRenderTick(): Promise<void> {
    const now = Date.now();

    // Check speed & sensor fusion DR estimate during render tick (time-driven prediction)
    const currentRouteId = this.speedEstimator.getNavStateEstimator().getState().routeId;
    const availableSegments = currentRouteId
      ? await this.repository.getSegmentsByRoute(currentRouteId)
      : this.latestSample
        ? await this.repository.findSegmentsNear(this.latestSample.latitude, this.latestSample.longitude, 2000)
        : [];

    this.currentFullSpeedState = await this.speedEstimator.getEstimateAtAsync(now, availableSegments);

    const currentSeg = this.speedEstimator.getNavStateEstimator().getCurrentSegment();

    // Update journey state during DR (continuous station & progress updates during GPS tunnel/outage)
    this.currentJourney = await this.journeyEstimator.update(
      this.latestSample,
      this.currentMatch,
      this.currentFullSpeedState,
      this.currentFullSpeedState.navState,
      currentSeg
    );
    this.speedEstimator.getNavStateEstimator().setDirection(
      this.toNavigationDirection(this.currentJourney.direction)
    );

    if (!this.currentFullSpeedState.isValid) {
      this.currentJourney.status = 'GPS_UNAVAILABLE';
    } else if (this.currentJourney.status === 'GPS_UNAVAILABLE') {
      this.currentJourney.status = this.currentMatch ? 'TRACKING' : 'ROUTE_UNCERTAIN';
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

  private toNavigationDirection(direction: JourneyState['direction']): 'UP' | 'DOWN' | 'UNKNOWN' {
    if (direction === 'UP' || direction === 'DIRECTION_A') return 'UP';
    if (direction === 'DOWN' || direction === 'DIRECTION_B') return 'DOWN';
    return 'UNKNOWN';
  }
}
