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

  // Location provider lifecycle serialization.
  // - `locationLifecycle` is a never-rejecting tail promise used as a FIFO queue so that
  //   start/stop/switch never overlap (a new provider is only started once the previous
  //   provider has fully stopped).
  // - `locationGeneration` is bumped whenever the active provider is invalidated, so
  //   notifications arriving late from an outgoing provider are ignored.
  private locationLifecycle: Promise<void> = Promise.resolve();
  private locationGeneration = 0;
  private activeLocationProvider: LocationProvider | null = null;

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

    // 1. Immediately start HUD render timer (Web Viewport DOM / Local Preview)
    this.renderTimerId = setInterval(() => {
      void this.runRenderTick();
    }, this.config.hudRefreshMs);

    // 2. Connect Even G2 in background with persistent auto-reconnect
    void this.connectEvenG2InBackground();

    // 3. Start the location provider through the lifecycle queue so start/stop/switch
    //    never interleave. Provider startup failures are reported through
    //    onLocationError and leave the controller running (HUD keeps rendering and
    //    falls back to GPS_UNAVAILABLE).
    await this.enqueueLocationLifecycle(() => this.activateLocationProvider(this.locationProvider));
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
          console.log('[AppController] Even G2 / Prototype Bridge connected successfully! Rendering HUD...');
          await this.evenG2Adapter.render(this.currentViewModel);
          attempt = 0;

          // Stay subscribed until OS exit / clear / disconnect, then reconnect.
          if (typeof this.evenG2Adapter.waitUntilDisconnected === 'function') {
            await this.evenG2Adapter.waitUntilDisconnected();
            if (!this.isRunning) break;
            console.warn('[AppController] Even G2 disconnected — scheduling reconnect...');
          } else {
            // Adapter without disconnect signaling: single connect is enough.
            break;
          }
          continue;
        }
      } catch (error) {
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

    // Ignore any notification still in flight from the running provider.
    this.locationGeneration++;

    if (this.renderTimerId) {
      clearInterval(this.renderTimerId);
      this.renderTimerId = null;
    }

    // Wait for any queued start/switch to settle before stopping the provider.
    await this.enqueueLocationLifecycle(() => this.deactivateLocationProvider());
    await this.evenG2Adapter.clear();
  }

  /**
   * Replaces the active location provider. The returned promise resolves once the
   * previous provider has been stopped and the new one has been started (or has
   * failed to start). Consecutive calls are serialized: only the most recently
   * requested provider is ever started.
   */
  public switchLocationProvider(newProvider: LocationProvider): Promise<void> {
    // Invalidate the outgoing provider immediately so its late notifications are
    // dropped even before its stop() resolves.
    this.locationGeneration++;
    this.locationProvider = newProvider;
    this.resetEstimationState();

    return this.enqueueLocationLifecycle(async () => {
      await this.deactivateLocationProvider();
      if (!this.isRunning) return;
      // A newer switch superseded this one while we were stopping: skip straight to it.
      if (this.locationProvider !== newProvider) return;
      await this.activateLocationProvider(newProvider);
    });
  }

  /** Serializes location provider lifecycle work (start / stop / switch) into a FIFO queue. */
  private enqueueLocationLifecycle(task: () => Promise<void>): Promise<void> {
    const run = this.locationLifecycle.then(task);
    // Keep the queue tail non-rejecting so one failure cannot poison later transitions
    // nor surface as an unhandled rejection.
    this.locationLifecycle = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async activateLocationProvider(provider: LocationProvider): Promise<void> {
    if (!this.isRunning) return;

    const generation = ++this.locationGeneration;
    this.activeLocationProvider = provider;
    try {
      await provider.start(
        (sample) => {
          if (generation !== this.locationGeneration) return;
          void this.onLocationUpdate(sample).catch((error) => {
            console.warn('[AppController] Location update failed:', error);
          });
        },
        (err) => {
          if (generation !== this.locationGeneration) return;
          this.onLocationError(err);
        }
      );
    } catch (error) {
      // Recover to a consistent state: no provider is considered active, the partially
      // started provider is torn down and stale estimation state is dropped so the HUD
      // reports GPS_UNAVAILABLE instead of freezing on pre-failure values.
      this.locationGeneration++;
      this.activeLocationProvider = null;
      await this.stopProviderSafely(provider);
      this.resetEstimationState();
      this.onLocationError(this.toLocationProviderError(error));
    }
  }

  private async deactivateLocationProvider(): Promise<void> {
    const provider = this.activeLocationProvider;
    this.activeLocationProvider = null;
    if (!provider) return;
    this.locationGeneration++;
    await this.stopProviderSafely(provider);
  }

  private async stopProviderSafely(provider: LocationProvider): Promise<void> {
    try {
      await provider.stop();
    } catch (error) {
      console.warn(
        '[AppController] Location provider stop notice:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private resetEstimationState(): void {
    this.speedEstimator.reset();
    this.journeyEstimator.reset();
    this.mapMatcher.reset();
    this.latestSample = null;
    this.currentMatch = null;
  }

  private toLocationProviderError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  /**
   * Processes one location sample. Results are computed into locals and only committed
   * while the sample's provider generation is still the current one: a switch/stop that
   * lands while map matching or journey estimation is awaited must not be able to write
   * stale state (or mutate the estimators) once it resolves.
   *
   * Called directly (without an active provider) the captured generation is the current
   * one, so the sample is always treated as live.
   */
  public async onLocationUpdate(sample: LocationSample): Promise<void> {
    // Captured synchronously at invocation: the provider callback checks the generation
    // and calls this in the same synchronous block, so both observe the same value.
    const generation = this.locationGeneration;

    // Safe to publish immediately: this runs before any await, so a later switch's
    // resetEstimationState() clears it rather than being overwritten by it. Keeping it
    // here avoids delaying HUD data by a full map-matching round trip on the normal path.
    this.latestSample = sample;

    // 1. NON-BLOCKING: Trigger background coverage fetch (do not await)
    void this.repository.ensureCoverageAround(sample.latitude, sample.longitude).catch((err) => {
      console.warn('[AppController] Background coverage fetch notice:', err);
    });

    // 2. Perform map matching with currently available segments
    const match = await this.mapMatcher.match(sample);
    // The provider was switched/stopped while matching: drop the sample before it can
    // mutate the (already reset) speed estimator.
    if (generation !== this.locationGeneration) return;

    // 3. Compute track distance progress if match is valid
    let trackProgress: { distanceAlongPolylineMeters: number; timestampMs: number } | undefined;
    if (match) {
      const closest = findClosestPointOnPolyline(
        sample.latitude,
        sample.longitude,
        match.selectedSegment.coordinates
      );
      trackProgress = {
        distanceAlongPolylineMeters: closest.distanceAlongPolylineMeters,
        timestampMs: sample.timestampMs,
      };
    }

    // 4. Immediate Speed Estimation (Un-blocked by network)
    const speedState = this.speedEstimator.update(sample, match, trackProgress);

    // 5. Estimate journey state & recover status if valid GPS returned
    const journey = await this.journeyEstimator.update(
      sample,
      match,
      speedState,
      speedState.navState
    );
    // Last checkpoint before publishing: a switch/stop during journey estimation wins.
    if (generation !== this.locationGeneration) return;

    this.currentMatch = match;
    this.currentFullSpeedState = speedState;
    this.currentJourney = journey;
    this.speedEstimator.getNavStateEstimator().setDirection(
      this.toNavigationDirection(this.currentJourney.direction)
    );
  }

  private onLocationError(err: { code?: number; message: string }): void {
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
    });

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
