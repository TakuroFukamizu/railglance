import { TrackingConfig } from '../config/tracking-config';
import { LocationSample, FullSpeedState, SpeedEstimate } from '../domain/models/location';
import { JourneyState, RouteMatch } from '../domain/models/railway';
import { HudViewModel } from '../domain/models/hud';
import { SpeedEstimator } from '../domain/speed/speed-estimator';
import { MapMatcher } from '../domain/railway/map-matcher';
import { JourneyStateEstimator } from '../domain/railway/journey-state-estimator';
import { RailwayDataRepository } from '../domain/railway/repository';
import { EvenG2Adapter } from '../infrastructure/even-g2/even-g2-adapter';
import { HudRenderer } from '../infrastructure/even-g2/hud-renderer';
import { LocationProvider } from '../infrastructure/geolocation/browser-location-provider';
import { EstimationLogEntry, EstimationLogger } from '../infrastructure/logging/logger';
import { findClosestPointOnPolyline } from '../domain/geo/polyline';
import { addRuntimeBreadcrumb, captureRuntimeError } from '../infrastructure/observability/sentry';

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
  private isConnectingEvenG2 = false;
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

    // 1. Immediately start location provider & GPS updates (non-blocking)
    this.startLocationProvider(this.locationProvider);

    // 2. Immediately start HUD render timer (Web Viewport DOM / Local Preview)
    this.renderTimerId = setInterval(() => {
      void this.runRenderTick();
    }, this.config.hudRefreshMs);

    // 3. Connect Even G2 in background with persistent auto-reconnect
    void this.connectEvenG2InBackground();
  }

  private async connectEvenG2InBackground(): Promise<void> {
    if (this.isConnectingEvenG2) return;
    this.isConnectingEvenG2 = true;

    let attempt = 0;
    while (this.isRunning) {
      attempt++;
      try {
        console.log(`[AppController] Connecting to Even G2 / Prototype Bridge (Attempt ${attempt})...`);
        const connected = await this.evenG2Adapter.connect();
        if (connected) {
          addRuntimeBreadcrumb('railglance.bridge', 'Even G2 connected', { attempt });
          console.log('[AppController] Even G2 / Prototype Bridge connected successfully! Rendering HUD...');
          await this.evenG2Adapter.render(this.currentViewModel);
          attempt = 0;

          // Stay subscribed until OS exit / clear / disconnect, then reconnect.
          if (typeof this.evenG2Adapter.waitUntilDisconnected === 'function') {
            await this.evenG2Adapter.waitUntilDisconnected();
            if (!this.isRunning) break;
            console.warn('[AppController] Even G2 disconnected — scheduling reconnect...');
            addRuntimeBreadcrumb('railglance.bridge', 'Even G2 disconnected', { attempt }, 'warning');
          } else {
            // Adapter without disconnect signaling: single connect is enough.
            break;
          }
          continue;
        }
      } catch (error) {
        captureRuntimeError(error, 'even-g2-connect', { attempt });
        console.warn(
          `[AppController] Even G2 connection attempt ${attempt} notice:`,
          error instanceof Error ? error.message : String(error)
        );
      }

      const backoffMs = Math.min(10000, 1000 * Math.pow(1.5, Math.min(attempt, 5)));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    this.isConnectingEvenG2 = false;
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
    await this.logger.shutdown();
  }

  public switchLocationProvider(newProvider: LocationProvider): void {
    void this.locationProvider.stop();
    this.speedEstimator.reset();
    this.journeyEstimator.reset();
    this.mapMatcher.reset();

    this.locationProvider = newProvider;
    if (this.isRunning) {
      this.startLocationProvider(this.locationProvider);
    }
  }

  private startLocationProvider(provider: LocationProvider): void {
    try {
      const startResult = provider.start(
        (sample) => {
          void this.onLocationUpdate(sample).catch((error) => {
            captureRuntimeError(error, 'location-update-processing');
            console.warn('[AppController] Location update processing failed:', error);
          });
        },
        (err) => this.onLocationError(err)
      );
      if (startResult) {
        void startResult.catch((error) => this.onLocationError(this.toLocationProviderError(error)));
      }
    } catch (error) {
      this.onLocationError(this.toLocationProviderError(error));
    }
  }

  private toLocationProviderError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  public async onLocationUpdate(sample: LocationSample): Promise<void> {
    this.latestSample = sample;
    const gpsAccepted = sample.accuracyMeters <= this.config.maxGpsAccuracyMeters;
    this.logger.logGpsObservation(
      sample,
      gpsAccepted,
      gpsAccepted ? undefined : 'accuracy-above-configured-limit'
    );

    // 1. NON-BLOCKING: Trigger background coverage fetch (do not await)
    void this.repository.ensureCoverageAround(sample.latitude, sample.longitude).catch((err) => {
      console.warn('[AppController] Background coverage fetch notice:', err);
      captureRuntimeError(err, 'railway-coverage-fetch');
      addRuntimeBreadcrumb('railglance.dataset', 'Railway coverage fetch failed', {}, 'warning');
    });

    // 2. Perform map matching with currently available segments
    this.currentMatch = await this.mapMatcher.match(sample);

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
    this.currentJourney = await this.journeyEstimator.update(
      sample,
      this.currentMatch,
      this.currentFullSpeedState,
      this.currentFullSpeedState.navState
    );
    this.speedEstimator.getNavStateEstimator().setDirection(
      this.toNavigationDirection(this.currentJourney.direction)
    );
  }

  private onLocationError(err: { code?: number; message: string }): void {
    console.warn('[AppController] Location error:', err.message);
    captureRuntimeError(new Error(err.message), 'geolocation', { code: err.code ?? null });
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
      captureRuntimeError(error, 'hud-render-tick');
    } finally {
      this.renderTickInFlight = false;
      if (this.renderTickPending && this.isRunning) void this.runRenderTick();
    }
  }

  private async onRenderTick(): Promise<void> {
    const now = Date.now();

    // Check speed & DR estimate during render tick
    const currentRouteId = this.speedEstimator.getNavStateEstimator().getState().routeId;
    const availableSegments = currentRouteId
      ? await this.repository.getSegmentsByRoute(currentRouteId)
      : this.latestSample
        ? await this.repository.findSegmentsNear(this.latestSample.latitude, this.latestSample.longitude, 2000)
        : [];

    this.currentFullSpeedState = await this.speedEstimator.getEstimateAtAsync(now, availableSegments);

    const currentSeg = this.speedEstimator.getNavStateEstimator().getCurrentSegment();

    // Update journey state during DR
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
    }

    this.currentViewModel = this.hudRenderer.createViewModel(
      this.currentFullSpeedState,
      this.currentJourney,
      now
    );

    // render() is non-blocking for Glass BLE (coalesced flush). Do not let a
    // slow/hung bridge transfer stall the AppController render loop.
    void this.evenG2Adapter.render(this.currentViewModel).catch((error) => {
      console.warn('[AppController] Even G2 render notice:', error);
      captureRuntimeError(error, 'even-g2-render');
    });

    const logEntry: EstimationLogEntry = {
      timestampMs: now,
      rawLocation: this.latestSample,
      speedState: this.currentFullSpeedState,
      match: this.currentMatch,
      journey: this.currentJourney,
      hudViewModel: this.currentViewModel,
      bridgeConnected: this.evenG2Adapter.isBridgeConnected?.() ?? false,
      lastImageResult: this.evenG2Adapter.getLastImageResult(),
    };
    this.logger.log(logEntry);
  }

  private toNavigationDirection(direction: JourneyState['direction']): 'UP' | 'DOWN' | 'UNKNOWN' {
    if (direction === 'UP' || direction === 'DIRECTION_A') return 'UP';
    if (direction === 'DOWN' || direction === 'DIRECTION_B') return 'DOWN';
    return 'UNKNOWN';
  }
}
