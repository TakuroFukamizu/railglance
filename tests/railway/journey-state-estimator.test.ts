import { describe, it, expect } from 'vitest';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { JourneyStateEstimator, StationDatabaseReader } from '../../src/domain/railway/journey-state-estimator';
import { RailwayLine, RouteMatch, Station, TrackSegment } from '../../src/domain/models/railway';
import { LocationSample, SpeedEstimate } from '../../src/domain/models/location';

class MockStationDatabase implements StationDatabaseReader {
  private stations: Station[] = [
    { id: 'st-1', lineId: 'line-1', name: '海老名', sequence: 1, latitude: 35.4526, longitude: 139.3900 },
    { id: 'st-2', lineId: 'line-1', name: '座間', sequence: 2, latitude: 35.4806, longitude: 139.4005 },
    { id: 'st-3', lineId: 'line-1', name: '相武台前', sequence: 3, latitude: 35.4988, longitude: 139.4144 },
  ];

  async getStationsByLine(): Promise<Station[]> {
    return this.stations;
  }
  async getStation(id: string): Promise<Station | undefined> {
    return this.stations.find((s) => s.id === id);
  }
}

describe('JourneyStateEstimator', () => {
  it('estimates direction, previous/next stations and remaining distance', async () => {
    const db = new MockStationDatabase();
    const estimator = new JourneyStateEstimator(db, DEFAULT_TRACKING_CONFIG);

    const line: RailwayLine = { id: 'line-1', operatorId: 'odakyu', name: '小田急線', directionAName: '上り', directionBName: '下り' };
    const seg: TrackSegment = {
      id: 'seg-1',
      lineId: 'line-1',
      fromStationId: 'st-1',
      toStationId: 'st-2',
      coordinates: [
        [35.4526, 139.3900],
        [35.4806, 139.4005],
      ],
      lengthMeters: 3200,
    };

    const match: RouteMatch = {
      selectedLine: line,
      selectedSegment: seg,
      confidence: 0.9,
      candidates: [],
      timestampMs: 10000,
    };

    const sample: LocationSample = {
      latitude: 35.4660,
      longitude: 139.3950,
      accuracyMeters: 10,
      speedMps: 25,
      headingDegrees: 30, // heading towards st-2 (Zama)
      timestampMs: 10000,
    };

    const speed: SpeedEstimate = {
      speedMps: 25,
      speedKmh: 90,
      rawSpeedKmh: 90,
      isStopped: false,
      isValid: true,
      timestampMs: 10000,
      source: 'gps',
    };

    const state = await estimator.update(sample, match, speed);

    expect(state.previousStation?.name).toBe('海老名');
    expect(state.nextStation?.name).toBe('座間');
    expect(state.distanceToNextStationMeters).toBeGreaterThan(1000);
    expect(state.distanceToNextStationMeters).toBeLessThan(3000);
    expect(state.status).toBe('TRACKING');
  });
});
