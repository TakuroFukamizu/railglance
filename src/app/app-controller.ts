import { TrackingConfig } from '../config/tracking-config';
import { LocationSample, FullSpeedState, SpeedEstimate } from '../domain/models/location';
import { JourneyState, RouteMatch, shouldDisplaySelectedRoute } from '../domain/models/railway';
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

/**
 * Upper bound for a single location provider `start()` / `stop()` call.
 *
 * These calls run inside the lifecycle FIFO queue, so one that never settles would
 * never release the queue tail and would wedge every later start/stop/switch. The
 * providers can genuinely park forever: `EvenAppLocationProvider.start()` awaits the
 * SDK's `waitForEvenAppBridge()`, which resolves on an `evenAppBridgeReady` event and
 * exposes no timeout of its own. Ten seconds is generous next to the provider's own
 * 5s `getAppLocation` bound while still failing fast enough that the user can reach
 * the demo/replay buttons.
 */
export const DEFAULT_LOCATION_LIFECYCLE_TIMEOUT_MS = 10_000;

/**
 * Largest delay `setTimeout` can actually hold (2^31 - 1 ms, ~24.9 days).
 *
 * Anything above it overflows the 32-bit timer and fires after ~1ms instead, so a
 * caller asking for a very long bound would silently get an instant one.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Raised when a provider lifecycle call exceeds its bound and is abandoned. */
export class LocationLifecycleTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocationLifecycleTimeoutError';
  }
}

export interface AppControllerOptions {
  /**
   * Overrides {@link DEFAULT_LOCATION_LIFECYCLE_TIMEOUT_MS}.
   *
   * Must be a finite, positive number of milliseconds. Anything else falls back to
   * the default; values beyond {@link MAX_TIMER_DELAY_MS} are clamped.
   */
  locationLifecycleTimeoutMs?: number;
}

/**
 * Resolves the configured lifecycle bound to a delay `setTimeout` can honour.
 *
 * `setTimeout` never rejects a bad delay, it quietly substitutes 1ms: `Infinity`,
 * `NaN` and negatives all fire on the next tick. Passing one through would not
 * restore the unbounded wait this bound exists to prevent — it causes the opposite
 * failure, every provider start being abandoned before it can succeed.
 */
function resolveLocationLifecycleTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LOCATION_LIFECYCLE_TIMEOUT_MS;

  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `[AppController] Ignoring invalid locationLifecycleTimeoutMs (${value}); ` +
        `falling back to ${DEFAULT_LOCATION_LIFECYCLE_TIMEOUT_MS}ms.`
    );
    return DEFAULT_LOCATION_LIFECYCLE_TIMEOUT_MS;
  }

  if (value > MAX_TIMER_DELAY_MS) {
    console.warn(
      `[AppController] Clamping locationLifecycleTimeoutMs (${value}) to ` +
        `${MAX_TIMER_DELAY_MS}ms, the longest delay setTimeout can hold.`
    );
    return MAX_TIMER_DELAY_MS;
  }

  return value;
}

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
  //   provider has fully stopped). Every provider call inside it is time-bounded so a
  //   provider that never settles cannot hold the tail and wedge all later transitions.
  // - `locationGeneration` is bumped whenever the active provider is invalidated, so
  //   notifications arriving late from an outgoing provider are ignored.
  private locationLifecycle: Promise<void> = Promise.resolve();
  private locationGeneration = 0;
  private activeLocationProvider: LocationProvider | null = null;
  private readonly locationLifecycleTimeoutMs: number;

  constructor(
    private locationProvider: LocationProvider,
    private mapMatcher: MapMatcher,
    private journeyEstimator: JourneyStateEstimator,
    private repository: RailwayDataRepository,
    private evenG2Adapter: EvenG2Adapter,
    private logger: EstimationLogger,
    private config: TrackingConfig,
    options: AppControllerOptions = {}
  ) {
    this.locationLifecycleTimeoutMs = resolveLocationLifecycleTimeoutMs(options.locationLifecycleTimeoutMs);
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

  public async startManualReacquire(): Promise<void> {
    const nowMs = Date.now();
    this.mapMatcher.startManualReacquire(nowMs);
    this.flushRouteLockEvents(nowMs);
    this.journeyEstimator.invalidateRoute();
    this.speedEstimator.getNavStateEstimator().clearRoute();
    if (this.latestSample) {
      await this.onLocationUpdate(this.latestSample);
    }
  }

  public async lockSelectedRoute(segmentId: string): Promise<boolean> {
    const nowMs = Date.now();
    const locked = this.mapMatcher.lockSelectedRoute(segmentId, nowMs);
    if (!locked) return false;
    this.flushRouteLockEvents(nowMs);
    if (this.latestSample) {
      await this.onLocationUpdate(this.latestSample);
    }
    return true;
  }

  public async unlockManualRoute(): Promise<void> {
    const nowMs = Date.now();
    this.mapMatcher.unlockManualRoute(nowMs);
    this.flushRouteLockEvents(nowMs);
    this.journeyEstimator.invalidateRoute();
    this.speedEstimator.getNavStateEstimator().clearRoute();
    this.currentMatch = null;
    if (this.latestSample) {
      await this.onLocationUpdate(this.latestSample);
    }
  }

  private flushRouteLockEvents(timestampMs: number): void {
    if (typeof this.mapMatcher.takeLockEvents !== 'function') return;
    this.logger.logRouteEvents(this.mapMatcher.takeLockEvents(), timestampMs);
  }

  public getCurrentRouteMatch(): RouteMatch | null {
    return this.currentMatch;
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

    // Ignore any notification still in flight from the running provider.
    this.locationGeneration++;

    if (this.renderTimerId) {
      clearInterval(this.renderTimerId);
      this.renderTimerId = null;
    }

    // Wait for any queued start/switch to settle before stopping the provider.
    await this.enqueueLocationLifecycle(() => this.deactivateLocationProvider());
    await this.evenG2Adapter.clear();
    await this.logger.shutdown();
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

  /**
   * Runs one provider lifecycle call under {@link locationLifecycleTimeoutMs}.
   *
   * Every start/stop happens inside the FIFO queue, so an unbounded call is not just
   * slow — it holds the queue tail forever and silently bricks the whole location
   * subsystem (later switches never run, stop() never reaches evenG2Adapter.clear()).
   * Bounding each call turns that permanent stall into an ordinary failure the
   * existing recovery path already handles.
   *
   * The abandoned call keeps running: `LocationProvider` has no abort protocol, so a
   * `start()` that eventually succeeds leaves a provider nobody will stop. Its
   * callbacks are gated on the generation captured before the call, which the
   * timeout path invalidates, so it can no longer write state — it just idles.
   */
  private async runProviderCall(description: string, call: () => void | Promise<void>): Promise<void> {
    // Normalizes the interface's `void | Promise<void>` return so synchronous
    // providers (BrowserLocationProvider) take exactly the same path.
    const pending = Promise.resolve(call());
    // Promise.race already tolerates a late settle, but keep the abandoned call
    // handled so a post-timeout rejection cannot surface as an unhandled rejection.
    void pending.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new LocationLifecycleTimeoutError(
              `${description} timed out after ${this.locationLifecycleTimeoutMs}ms`
            )
          ),
        this.locationLifecycleTimeoutMs
      );
    });

    try {
      await Promise.race([pending, expiry]);
    } finally {
      // Also covers the synchronous-provider path, which resolves before the timer
      // ever fires and would otherwise keep a live handle for the full bound.
      clearTimeout(timer);
    }
  }

  private async activateLocationProvider(provider: LocationProvider): Promise<void> {
    if (!this.isRunning) return;

    const generation = ++this.locationGeneration;
    this.activeLocationProvider = provider;
    try {
      await this.runProviderCall('Location provider start()', () =>
        provider.start(
          (sample) => {
            if (generation !== this.locationGeneration) return;
            void this.onLocationUpdate(sample).catch((error) => {
              captureRuntimeError(error, 'location-update-processing');
              console.warn('[AppController] Location update processing failed:', error);
            });
          },
          (err) => {
            if (generation !== this.locationGeneration) return;
            this.onLocationError(err);
          }
        )
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
      await this.runProviderCall('Location provider stop()', () => provider.stop());
    } catch (error) {
      if (error instanceof LocationLifecycleTimeoutError) {
        // Reported separately from a stop() rejection: the call is still running and
        // the provider may never actually release its subscription.
        console.warn('[AppController] Location provider stop abandoned:', error.message);
        return;
      }
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
    const match = await this.mapMatcher.match(sample);
    // The provider was switched/stopped while matching: drop the sample before it can
    // mutate the (already reset) speed estimator.
    if (generation !== this.locationGeneration) return;
    this.flushRouteLockEvents(sample.timestampMs);
    this.logger.logRouteObservation(sample, match);

    // 3. Compute track distance progress if match is valid
    let trackProgress: { distanceAlongPolylineMeters: number; timestampMs: number } | undefined;
    if (match && shouldDisplaySelectedRoute(match)) {
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
