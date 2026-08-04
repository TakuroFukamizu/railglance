import { describe, expect, it, vi } from 'vitest';
import { AppController } from '../../src/app/app-controller';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { JourneyStateEstimator } from '../../src/domain/railway/journey-state-estimator';
import { RailwayDataRepository } from '../../src/domain/railway/repository';
import { RailwayLine, RouteMatch, Station, TrackSegment } from '../../src/domain/models/railway';
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
const match: RouteMatch = {
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

describe('AppController route loss', () => {
  it('invalidates stale line/station state after grace and recovers on re-entry', async () => {
    const mapMatcher = { match: vi.fn(), reset: vi.fn() };
    mapMatcher.match
      .mockResolvedValueOnce(match)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(match);
    const controller = new AppController(
      { start: vi.fn(), stop: vi.fn() },
      mapMatcher as any,
      new JourneyStateEstimator(repository, DEFAULT_TRACKING_CONFIG),
      repository,
      { connect: async () => true, render: vi.fn(), clear: vi.fn(), getLastImageResult: () => 'none' },
      new EstimationLogger(),
      DEFAULT_TRACKING_CONFIG
    );

    await controller.onLocationUpdate(sample(1_000));
    expect((controller as any).currentJourney.line?.id).toBe('line');

    await controller.onLocationUpdate(sample(2_000));
    expect((controller as any).currentJourney.line?.id).toBe('line');

    await controller.onLocationUpdate(sample(2_000 + DEFAULT_TRACKING_CONFIG.routeMatchLossGraceMs));
    expect((controller as any).currentJourney).toMatchObject({
      line: null,
      previousStation: null,
      nextStation: null,
      status: 'ROUTE_UNCERTAIN',
    });

    await controller.onLocationUpdate(sample(11_000));
    expect((controller as any).currentJourney.line?.id).toBe('line');
  });
});
