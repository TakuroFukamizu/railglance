import { describe, expect, it, vi } from 'vitest';
import {
  AppController,
  AppControllerOptions,
  DEFAULT_LOCATION_LIFECYCLE_TIMEOUT_MS,
} from '../../src/app/app-controller';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { RailwayDataRepository } from '../../src/domain/railway/repository';
import { RailwayLine, RouteMatch, Station, TrackSegment } from '../../src/domain/models/railway';
import { LocationSample } from '../../src/domain/models/location';
import { LocationProvider, LocationProviderError } from '../../src/infrastructure/geolocation/browser-location-provider';
import { EstimationLogger } from '../../src/infrastructure/logging/logger';

const line: RailwayLine = { id: 'line', operatorId: 'op', name: 'Test Line' };
const stations: Station[] = [
  { id: 'a', lineId: 'line', name: 'A', sequence: 1, latitude: 35, longitude: 139 },
  { id: 'b', lineId: 'line', name: 'B', sequence: 2, latitude: 35.01, longitude: 139 },
];
const segment: TrackSegment = {
  id: 'ab', lineId: 'line', routeId: 'route-line-main', fromStationId: 'a', toStationId: 'b',
  coordinates: [[35, 139], [35.01, 139]], lengthMeters: 1112, startOffsetMeters: 0,
};
const routeMatch: RouteMatch = {
  selectedLine: line, selectedSegment: segment, confidence: 0.9, candidates: [], timestampMs: 0,
};

const repository: RailwayDataRepository = {
  ensureCoverageAround: async () => ({ state: 'bundled', loadedTileCount: 0 }),
  findSegmentsNear: async () => [segment],
  getLine: async () => line,
  getRoute: async () => undefined,
  getStation: async (id) => stations.find((station) => station.id === id),
  getStationsByLine: async () => stations,
  getSegmentsByRoute: async () => [segment],
  getDataState: () => 'bundled',
};

function sample(timestampMs: number): LocationSample {
  return {
    latitude: 35.005,
    longitude: 139,
    accuracyMeters: 5,
    speedMps: 10,
    headingDegrees: 0,
    timestampMs,
  };
}

/** Flushes pending microtasks and timer-0 callbacks. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A promise that never settles — models a provider call that parks forever. */
function never(): Promise<void> {
  return new Promise<void>(() => {});
}

/**
 * Resolves to true if `promise` settles within `ms`, false otherwise.
 *
 * Used so a wedged lifecycle queue fails as an explicit assertion instead of an
 * opaque vitest timeout.
 */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

/** Test double that records lifecycle calls and exposes the callbacks it received. */
class FakeLocationProvider implements LocationProvider {
  public startCalls = 0;
  public stopCalls = 0;
  public onLocation: ((sample: LocationSample) => void) | null = null;
  public onError: ((err: LocationProviderError) => void) | null = null;

  constructor(
    private readonly hooks: {
      startResult?: () => Promise<void>;
      stopResult?: () => Promise<void>;
    } = {}
  ) {}

  public async start(
    onLocation: (sample: LocationSample) => void,
    onError?: (err: LocationProviderError) => void
  ): Promise<void> {
    this.startCalls++;
    this.onLocation = onLocation;
    this.onError = onError ?? null;
    if (this.hooks.startResult) await this.hooks.startResult();
  }

  public async stop(): Promise<void> {
    this.stopCalls++;
    if (this.hooks.stopResult) await this.hooks.stopResult();
  }
}

function createJourneyEstimator() {
  return {
    update: vi.fn().mockResolvedValue({
      line: null,
      direction: 'UNKNOWN',
      directionName: null,
      previousStation: null,
      nextStation: null,
      distanceToNextStationMeters: null,
      progressRatio: null,
      confidence: 0,
      status: 'INITIALIZING',
    }),
    reset: vi.fn(),
  };
}

function createController(
  provider: LocationProvider,
  mapMatcher = { match: vi.fn().mockResolvedValue(null), reset: vi.fn() },
  journeyEstimator = createJourneyEstimator(),
  options: AppControllerOptions = {}
) {
  // No waitUntilDisconnected: the background connect loop exits after one connect.
  const evenG2Adapter = {
    connect: async () => true,
    render: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getLastImageResult: () => 'none',
  };
  const controller = new AppController(
    provider,
    mapMatcher as any,
    journeyEstimator as any,
    repository,
    evenG2Adapter,
    new EstimationLogger(),
    DEFAULT_TRACKING_CONFIG,
    options
  );
  return { controller, mapMatcher, journeyEstimator, evenG2Adapter };
}

describe('AppController location provider lifecycle', () => {
  it('starts the new provider only after a slow stop of the previous one resolves', async () => {
    const slowStop = deferred();
    const initial = new FakeLocationProvider({ stopResult: () => slowStop.promise });
    const replacement = new FakeLocationProvider();
    const { controller } = createController(initial);

    await controller.start();
    expect(initial.startCalls).toBe(1);

    const switching = controller.switchLocationProvider(replacement);
    await flush();

    // The outgoing provider has been asked to stop but has not finished yet,
    // so the replacement must not be started (no overlapping providers).
    expect(initial.stopCalls).toBe(1);
    expect(replacement.startCalls).toBe(0);

    slowStop.resolve();
    await switching;

    expect(replacement.startCalls).toBe(1);
    expect(initial.stopCalls).toBe(1);

    await controller.stop();
    expect(replacement.stopCalls).toBe(1);
  });

  it('ignores location notifications emitted by the outgoing provider after a switch', async () => {
    const slowStop = deferred();
    const initial = new FakeLocationProvider({ stopResult: () => slowStop.promise });
    const replacement = new FakeLocationProvider();
    const mapMatcher = { match: vi.fn().mockResolvedValue(null), reset: vi.fn() };
    const { controller } = createController(initial, mapMatcher);

    await controller.start();
    initial.onLocation?.(sample(1_000));
    await flush();
    expect(mapMatcher.match).toHaveBeenCalledTimes(1);

    const switching = controller.switchLocationProvider(replacement);
    // Late notification from the provider that is being torn down.
    initial.onLocation?.(sample(2_000));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    initial.onError?.({ message: 'stale provider error' });
    await flush();

    expect(mapMatcher.match).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith('[AppController] Location error:', 'stale provider error');

    slowStop.resolve();
    await switching;

    // The new provider's notifications are processed normally.
    replacement.onLocation?.(sample(3_000));
    await flush();
    expect(mapMatcher.match).toHaveBeenCalledTimes(2);
    expect((controller as any).latestSample?.timestampMs).toBe(3_000);

    warn.mockRestore();
    await controller.stop();
  });

  it('does not commit a location update that was still in flight when the provider was switched', async () => {
    const initial = new FakeLocationProvider();
    const replacement = new FakeLocationProvider();

    // Map matching for the stale sample stays pending across the switch.
    let resolveMatch!: (value: RouteMatch | null) => void;
    const pendingMatch = new Promise<RouteMatch | null>((resolve) => {
      resolveMatch = resolve;
    });
    const mapMatcher = { match: vi.fn().mockReturnValue(pendingMatch), reset: vi.fn() };
    const { controller, journeyEstimator } = createController(initial, mapMatcher);

    await controller.start();

    // Accepted while `initial` is still the current generation, so the callback gate
    // lets it through — the staleness only appears while it is awaiting map matching.
    initial.onLocation?.(sample(1_000));
    await flush();
    expect(mapMatcher.match).toHaveBeenCalledTimes(1);
    expect((controller as any).currentMatch).toBeNull();

    await controller.switchLocationProvider(replacement);
    expect(mapMatcher.reset).toHaveBeenCalled();
    expect((controller as any).currentMatch).toBeNull();

    // Map matching for the stale sample completes only now, after the switch.
    resolveMatch(routeMatch);
    await flush();

    // It must not resurrect state the switch just cleared, nor feed the (already reset)
    // estimators with the outgoing provider's sample.
    expect((controller as any).currentMatch).toBeNull();
    expect((controller as any).latestSample).toBeNull();
    expect(
      journeyEstimator.update.mock.calls.some((call) => call[0]?.timestampMs === 1_000)
    ).toBe(false);

    await controller.stop();
  });

  it('recovers to a consistent state when the provider fails to start', async () => {
    const failing = new FakeLocationProvider({
      startResult: () => Promise.reject(new Error('provider start failed')),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { controller, mapMatcher } = createController(failing);

    await controller.start();

    expect(warn).toHaveBeenCalledWith('[AppController] Location error:', 'provider start failed');
    // The half-started provider is torn down and no provider is left marked active.
    expect(failing.stopCalls).toBe(1);
    expect((controller as any).activeLocationProvider).toBeNull();
    // Estimation state is reset so the HUD falls back to a GPS-unavailable view.
    expect((controller as any).latestSample).toBeNull();
    expect((controller as any).currentMatch).toBeNull();
    expect(mapMatcher.reset).toHaveBeenCalled();

    await (controller as any).onRenderTick();
    expect((controller as any).currentJourney.status).toBe('GPS_UNAVAILABLE');

    // Late callbacks from the failed provider must not be processed.
    failing.onLocation?.(sample(1_000));
    await flush();
    expect((controller as any).latestSample).toBeNull();

    // The controller keeps running and can still adopt a working provider.
    const healthy = new FakeLocationProvider();
    await controller.switchLocationProvider(healthy);
    expect(healthy.startCalls).toBe(1);
    // The failed provider is not stopped twice.
    expect(failing.stopCalls).toBe(1);

    await controller.stop();
    warn.mockRestore();
  });

  it('serializes rapid consecutive switches and only starts the final provider', async () => {
    const slowStop = deferred();
    const initial = new FakeLocationProvider({ stopResult: () => slowStop.promise });
    const intermediate = new FakeLocationProvider();
    const final = new FakeLocationProvider();
    const { controller } = createController(initial);

    await controller.start();

    const first = controller.switchLocationProvider(intermediate);
    const second = controller.switchLocationProvider(final);
    slowStop.resolve();
    await Promise.all([first, second]);

    expect(initial.stopCalls).toBe(1);
    expect(intermediate.startCalls).toBe(0);
    expect(intermediate.stopCalls).toBe(0);
    expect(final.startCalls).toBe(1);
    expect((controller as any).activeLocationProvider).toBe(final);

    await controller.stop();
    expect(final.stopCalls).toBe(1);
  });

  it('does not start a provider when switching while the controller is stopped', async () => {
    const initial = new FakeLocationProvider();
    const replacement = new FakeLocationProvider();
    const { controller } = createController(initial);

    await controller.start();
    await controller.stop();
    expect(initial.stopCalls).toBe(1);

    await controller.switchLocationProvider(replacement);
    expect(replacement.startCalls).toBe(0);
  });

  it('reports a provider stop failure without an unhandled rejection', async () => {
    const initial = new FakeLocationProvider({
      stopResult: () => Promise.reject(new Error('stop failed')),
    });
    const replacement = new FakeLocationProvider();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { controller } = createController(initial);

    await controller.start();
    await controller.switchLocationProvider(replacement);

    expect(warn).toHaveBeenCalledWith('[AppController] Location provider stop notice:', 'stop failed');
    expect(replacement.startCalls).toBe(1);

    warn.mockRestore();
    await controller.stop();
  });

  it('keeps switching and stopping possible when a provider start() never settles', async () => {
    // `EvenAppLocationProvider.start()` awaits the SDK's `waitForEvenAppBridge()`,
    // which has no timeout of its own: a bridge that never signals ready parks the
    // call forever. Without a bound it would hold the lifecycle queue's tail and
    // every later transition would be queued behind it indefinitely.
    const hanging = new FakeLocationProvider({ startResult: never });
    const replacement = new FakeLocationProvider();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { controller, evenG2Adapter } = createController(
      hanging,
      undefined,
      undefined,
      { locationLifecycleTimeoutMs: 20 }
    );

    expect(await settlesWithin(controller.start(), 500)).toBe(true);
    expect(hanging.startCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[AppController] Location error:',
      'Location provider start() timed out after 20ms'
    );
    // The abandoned provider is treated as a start failure, so nothing is left active.
    expect((controller as any).activeLocationProvider).toBeNull();

    // The user can still reach the demo/replay providers.
    const switching = controller.switchLocationProvider(replacement);
    expect(await settlesWithin(switching, 500)).toBe(true);
    expect(replacement.startCalls).toBe(1);

    // ...and stop() still runs to completion, so the glass gets cleared.
    const stopping = controller.stop();
    expect(await settlesWithin(stopping, 500)).toBe(true);
    expect(replacement.stopCalls).toBe(1);
    expect(evenG2Adapter.clear).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('keeps switching and stopping possible when a provider stop() never settles', async () => {
    // The bound has to cover stop() too: the start-failure recovery path and every
    // switch await it, so a stop() that parks forever wedges the queue just as badly.
    const hanging = new FakeLocationProvider({ stopResult: never });
    const replacement = new FakeLocationProvider();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { controller, evenG2Adapter } = createController(
      hanging,
      undefined,
      undefined,
      { locationLifecycleTimeoutMs: 20 }
    );

    await controller.start();
    expect(hanging.startCalls).toBe(1);

    const switching = controller.switchLocationProvider(replacement);
    expect(await settlesWithin(switching, 500)).toBe(true);
    expect(hanging.stopCalls).toBe(1);
    expect(replacement.startCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[AppController] Location provider stop abandoned:',
      'Location provider stop() timed out after 20ms'
    );

    const stopping = controller.stop();
    expect(await settlesWithin(stopping, 500)).toBe(true);
    expect(evenG2Adapter.clear).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('falls back to the default bound when the configured one is unusable', async () => {
    // setTimeout silently substitutes 1ms for Infinity/NaN/negatives, which would
    // abandon every start instead of restoring the unbounded wait.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { controller } = createController(new FakeLocationProvider(), undefined, undefined, {
      locationLifecycleTimeoutMs: Number.POSITIVE_INFINITY,
    });

    expect((controller as any).locationLifecycleTimeoutMs).toBe(DEFAULT_LOCATION_LIFECYCLE_TIMEOUT_MS);
    expect(warn).toHaveBeenCalledWith(
      `[AppController] Ignoring invalid locationLifecycleTimeoutMs (Infinity); ` +
        `falling back to ${DEFAULT_LOCATION_LIFECYCLE_TIMEOUT_MS}ms.`
    );

    warn.mockRestore();
    await controller.stop();
  });
});
