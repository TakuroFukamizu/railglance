import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { MapMatcher, RailwayDatabaseReader } from '../../src/domain/railway/map-matcher';
import { RailwayLine, TrackSegment } from '../../src/domain/models/railway';
import { LocationSample } from '../../src/domain/models/location';

class MockRailwayDatabase implements RailwayDatabaseReader {
  public line: RailwayLine = {
    id: 'test-line',
    operatorId: 'op',
    name: 'テスト線',
  };

  public segA: TrackSegment = {
    id: 'seg-A',
    lineId: 'test-line',
    fromStationId: 'st1',
    toStationId: 'st2',
    coordinates: [
      [35.0, 139.0],
      [35.1, 139.0],
    ],
  };

  public segB: TrackSegment = {
    id: 'seg-B',
    lineId: 'test-line',
    fromStationId: 'st2',
    toStationId: 'st3',
    coordinates: [
      [35.1, 139.0],
      [35.2, 139.0],
    ],
  };

  async findSegmentsNear(): Promise<TrackSegment[]> {
    return [this.segA, this.segB];
  }

  async getLine(lineId: string): Promise<RailwayLine | undefined> {
    if (lineId === 'test-line') return this.line;
    return undefined;
  }
}

describe('MapMatcher', () => {
  let db: MockRailwayDatabase;
  let matcher: MapMatcher;

  beforeEach(() => {
    db = new MockRailwayDatabase();
    matcher = new MapMatcher(db, DEFAULT_TRACKING_CONFIG);
  });

  it('matches closest line segment and returns valid confidence', async () => {
    const sample: LocationSample = {
      latitude: 35.05,
      longitude: 139.0,
      accuracyMeters: 10,
      speedMps: 20,
      headingDegrees: 0,
      timestampMs: 10000,
    };

    const match = await matcher.match(sample);
    expect(match).not.toBeNull();
    expect(match?.selectedSegment.id).toBe('seg-A');
    expect(match?.confidence).toBeGreaterThan(0.5);
  });

  it('suppresses rapid route switching using hysteresis rules', async () => {
    // 1st sample near seg-A
    const sample1: LocationSample = {
      latitude: 35.02,
      longitude: 139.0,
      accuracyMeters: 10,
      speedMps: 20,
      headingDegrees: 0,
      timestampMs: 10000,
    };
    const m1 = await matcher.match(sample1);
    expect(m1?.selectedSegment.id).toBe('seg-A');

    // 2nd sample slightly closer to seg-B but not enough consecutive times
    const sample2: LocationSample = {
      latitude: 35.12,
      longitude: 139.0,
      accuracyMeters: 10,
      speedMps: 20,
      headingDegrees: 0,
      timestampMs: 11000,
    };
    const m2 = await matcher.match(sample2);
    // Should still hold seg-A due to hysteresis count threshold (requires 3 consecutive or 5s)
    expect(m2?.selectedSegment.id).toBe('seg-A');
  });
});
