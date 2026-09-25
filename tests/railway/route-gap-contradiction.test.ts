import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { LocationSample } from '../../src/domain/models/location';
import { RailwayLine, TrackSegment } from '../../src/domain/models/railway';
import { scoreCandidate } from '../../src/domain/railway/candidate-scorer';
import { MapMatcher, RailwayDatabaseReader } from '../../src/domain/railway/map-matcher';

/**
 * Issue #69: the station-hole projection defends the locked segment past its end, which is
 * right inside a hole in that line's data but wrong once the rider has changed to another
 * railway that runs through the same place (JR -> 京急 at 品川).
 */
const JR: RailwayLine = { id: 'jr-line', operatorId: 'jr', name: 'JR線' };
const OTHER: RailwayLine = { id: 'other-line', operatorId: 'other', name: '私鉄線' };

const METERS_PER_DEG_LAT = 111_320;
const METERS_PER_DEG_LON = 91_000;
const north = (meters: number) => 35 + meters / METERS_PER_DEG_LAT;
const east = (meters: number) => 139 + meters / METERS_PER_DEG_LON;

/** Ends at 500 m; the platform and the rest of the ride are past this point. */
const jrSegment: TrackSegment = {
  id: 'jr-1',
  lineId: JR.id,
  routeId: 'jr-route',
  fromStationId: 'jr-a',
  toStationId: 'jr-b',
  coordinates: [
    [north(0), east(0)],
    [north(500), east(0)],
  ],
  startOffsetMeters: 0,
};

/** Picks up 40 m east of the JR end and carries on north: a different railway. */
const otherSegment: TrackSegment = {
  id: 'other-1',
  lineId: OTHER.id,
  routeId: 'other-route',
  fromStationId: 'other-a',
  toStationId: 'other-b',
  coordinates: [
    [north(480), east(40)],
    [north(1200), east(40)],
  ],
  startOffsetMeters: 0,
};

class TwoRailwaysDb implements RailwayDatabaseReader {
  async findSegmentsNear(): Promise<TrackSegment[]> {
    return [jrSegment, otherSegment];
  }
  async getLine(lineId: string): Promise<RailwayLine | undefined> {
    return lineId === JR.id ? JR : OTHER;
  }
}

function sample(northMeters: number, eastMeters: number, timestampMs: number): LocationSample {
  return {
    latitude: north(northMeters),
    longitude: east(eastMeters),
    accuracyMeters: 10,
    speedMps: 15,
    headingDegrees: 0,
    timestampMs,
  };
}

describe('station-hole projection: continuity fades past the segment end', () => {
  const score = (northMeters: number) =>
    scoreCandidate({
      sample: sample(northMeters, 0, 1_000),
      segment: jrSegment,
      line: JR,
      previousSegment: jrSegment,
      nearbySegments: [jrSegment, otherSegment],
      lockState: 'LOCKED',
      effectiveHeadingDegrees: 0,
      config: DEFAULT_TRACKING_CONFIG,
    });

  it('keeps the full same-segment bonus while the fix is on the segment', () => {
    const onSegment = score(400);
    expect(onSegment.endOverrunMeters).toBe(0);
    expect(onSegment.continuityScore).toBe(DEFAULT_TRACKING_CONFIG.continuitySameSegment);
  });

  it('fades the bonus out as the fix runs past the end', () => {
    const justPast = score(560);
    const farPast = score(700);
    expect(justPast.endOverrunMeters).toBeGreaterThan(0);
    expect(justPast.continuityScore).toBeLessThan(DEFAULT_TRACKING_CONFIG.continuitySameSegment);
    expect(farPast.continuityScore).toBeLessThan(justPast.continuityScore);
    expect(score(500 + DEFAULT_TRACKING_CONFIG.routeSegmentGapContinuityFadeMeters).continuityScore).toBe(0);
  });
});

describe('station-hole projection: another railway carrying the fixes contradicts the lock', () => {
  it('turns the lock suspicious once the other line is clearly closer for several fixes', async () => {
    const matcher = new MapMatcher(new TwoRailwaysDb(), DEFAULT_TRACKING_CONFIG);
    // Ride the JR segment and lock onto it.
    for (let i = 0; i < 12; i++) await matcher.match(sample(i * 30, 0, 1_000 + i * 1_000));
    expect(matcher.getLockState()).toBe('LOCKED');

    // Continue on the other railway, 40 m east, past where the JR data ends.
    const states: string[] = [];
    for (let i = 0; i < 12; i++) {
      const match = await matcher.match(sample(520 + i * 30, 40, 20_000 + i * 1_000));
      if (match?.lockState) states.push(match.lockState);
    }

    expect(states).toContain('SUSPICIOUS');
    expect(states.indexOf('SUSPICIOUS')).toBeLessThanOrEqual(
      DEFAULT_TRACKING_CONFIG.routeSegmentGapContradictionCount + 1
    );
  });

  it('keeps a lock whose own track simply has a hole', async () => {
    // Same geometry, but the far-side segment is this line's own track continuing north.
    const continuation: TrackSegment = {
      ...otherSegment,
      id: 'jr-2',
      lineId: JR.id,
      routeId: 'jr-route',
      coordinates: [
        [north(800), east(0)],
        [north(1500), east(0)],
      ],
    };
    const db: RailwayDatabaseReader = {
      async findSegmentsNear() {
        return [jrSegment, continuation];
      },
      async getLine() {
        return JR;
      },
    };
    const matcher = new MapMatcher(db, DEFAULT_TRACKING_CONFIG);
    for (let i = 0; i < 12; i++) await matcher.match(sample(i * 30, 0, 1_000 + i * 1_000));
    expect(matcher.getLockState()).toBe('LOCKED');

    for (let i = 0; i < 8; i++) await matcher.match(sample(520 + i * 30, 0, 20_000 + i * 1_000));
    expect(matcher.getLockState()).toBe('LOCKED');
  });
});
