import { describe, expect, it, vi } from 'vitest';
import { AppController } from '../../src/app/app-controller';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { RailwayDataRepository } from '../../src/domain/railway/repository';
import { JourneyState, RailwayLine, RouteMatch, Station, TrackSegment } from '../../src/domain/models/railway';
import { LocationSample } from '../../src/domain/models/location';
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

const idleJourney: JourneyState = {
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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createController(overrides: {
  mapMatcher?: { match: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };
  journeyEstimator?: {
    update: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    invalidateRoute?: ReturnType<typeof vi.fn>;
  };
  hudRefreshMs?: number;
} = {}) {
  const mapMatcher = overrides.mapMatcher ?? {
    match: vi.fn().mockResolvedValue(routeMatch),
    reset: vi.fn(),
  };
  const journeyEstimator = overrides.journeyEstimator ?? {
    update: vi.fn().mockResolvedValue(idleJourney),
    reset: vi.fn(),
    invalidateRoute: vi.fn(),
  };
  const evenG2Adapter = {
    connect: async () => true,
    render: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getLastImageResult: () => 'none',
  };
  const logger = new EstimationLogger();
  const controller = new AppController(
    { start: vi.fn(), stop: vi.fn() },
    mapMatcher as any,
    journeyEstimator as any,
    repository,
    evenG2Adapter,
    logger,
    { ...DEFAULT_TRACKING_CONFIG, hudRefreshMs: overrides.hudRefreshMs ?? 1_000_000 }
  );
  return { controller, mapMatcher, journeyEstimator, evenG2Adapter, logger };
}

describe('AppController HUD latency', () => {
  it('publishes a committed location update immediately even when hudRefreshMs is very large', async () => {
    const { controller, evenG2Adapter, logger } = createController({ hudRefreshMs: 1_000_000 });
    const logSpy = vi.spyOn(logger, 'log');

    await controller.onLocationUpdate(sample(1_000));

    expect(evenG2Adapter.render).toHaveBeenCalledTimes(1);
    expect(evenG2Adapter.render).toHaveBeenCalledWith(
      expect.objectContaining({
        timestampMs: expect.any(Number),
        speed: expect.objectContaining({ displaySpeedKmhText: expect.any(String) }),
      })
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rawLocation: expect.objectContaining({ timestampMs: 1_000 }),
        hudViewModel: expect.objectContaining({ timestampMs: expect.any(Number) }),
      })
    );
  });

  it('does not rematch or re-estimate journey when publishing the HUD after a location update', async () => {
    const mapMatcher = { match: vi.fn().mockResolvedValue(routeMatch), reset: vi.fn() };
    const journeyEstimator = {
      update: vi.fn().mockResolvedValue(idleJourney),
      reset: vi.fn(),
      invalidateRoute: vi.fn(),
    };
    const { controller } = createController({ mapMatcher, journeyEstimator });

    await controller.onLocationUpdate(sample(1_000));

    expect(mapMatcher.match).toHaveBeenCalledTimes(1);
    expect(journeyEstimator.update).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping real GPS updates and processes each fix once', async () => {
    const resolvers: Array<(value: RouteMatch | null) => void> = [];
    const mapMatcher = {
      match: vi.fn().mockImplementation(
        () =>
          new Promise<RouteMatch | null>((resolve) => {
            resolvers.push(resolve);
          })
      ),
      reset: vi.fn(),
    };
    const journeyEstimator = {
      update: vi.fn().mockResolvedValue(idleJourney),
      reset: vi.fn(),
      invalidateRoute: vi.fn(),
    };
    const { controller } = createController({ mapMatcher, journeyEstimator });

    const first = controller.onLocationUpdate(sample(1_000));
    const second = controller.onLocationUpdate(sample(2_000));
    await flush();

    expect(mapMatcher.match).toHaveBeenCalledTimes(1);
    expect(mapMatcher.match).toHaveBeenCalledWith(expect.objectContaining({ timestampMs: 1_000 }));
    expect(resolvers).toHaveLength(1);

    resolvers[0](routeMatch);
    await flush();

    expect(mapMatcher.match).toHaveBeenCalledTimes(2);
    expect(mapMatcher.match).toHaveBeenCalledWith(expect.objectContaining({ timestampMs: 2_000 }));
    expect(resolvers).toHaveLength(2);

    resolvers[1](routeMatch);
    await Promise.all([first, second]);

    expect(mapMatcher.match).toHaveBeenCalledTimes(2);
    expect(journeyEstimator.update).toHaveBeenCalledTimes(2);
    expect((controller as any).latestSample?.timestampMs).toBe(2_000);
  });
});
