import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACKING_CONFIG, TrackingConfig } from '../../src/config/tracking-config';
import { LocationSample } from '../../src/domain/models/location';
import { RailwayLine, TrackSegment } from '../../src/domain/models/railway';
import { computeTrajectory, osSpeedStopped, resolveEffectiveHeading } from '../../src/domain/geo/trajectory';
import { MapMatcher, RailwayDatabaseReader } from '../../src/domain/railway/map-matcher';
import { evaluateRouteHealth, RouteObservation } from '../../src/domain/railway/route-health';
import { scoreRoutesOverWindow } from '../../src/domain/railway/window-scorer';

const LINE: RailwayLine = { id: 'line-a', operatorId: 'op', name: '在来線A' };

const route1: TrackSegment = {
  id: 'route-1-seg',
  lineId: LINE.id,
  routeId: 'route-1',
  fromStationId: 'st-ebina',
  toStationId: 'st-zama',
  coordinates: [
    [35.0, 139.0],
    [35.1, 139.0],
  ],
  startOffsetMeters: 0,
  previousSegmentIds: [],
  nextSegmentIds: ['route-1-next'],
};

const route2: TrackSegment = {
  id: 'route-2-seg',
  lineId: LINE.id,
  routeId: 'route-2',
  fromStationId: 'st-shinjuku',
  toStationId: 'st-yoyogi',
  coordinates: [
    [35.2, 139.02],
    [35.3, 139.02],
  ],
  startOffsetMeters: 0,
  previousSegmentIds: [],
  nextSegmentIds: [],
};

class DualRouteDb implements RailwayDatabaseReader {
  constructor(public segments: TrackSegment[]) {}
  async findSegmentsNear(): Promise<TrackSegment[]> {
    return this.segments;
  }
  async getLine(): Promise<RailwayLine | undefined> {
    return LINE;
  }
  async getStation(id: string) {
    const sequences: Record<string, number> = { 'st-ebina': 1, 'st-zama': 2, 'st-shinjuku': 8, 'st-yoyogi': 9 };
    return { id, lineId: LINE.id, name: id, sequence: sequences[id] ?? 0, latitude: 35, longitude: 139 };
  }
}

function sample(lat: number, lon: number, timestampMs: number, extras: Partial<LocationSample> = {}): LocationSample {
  return {
    latitude: lat,
    longitude: lon,
    accuracyMeters: 10,
    speedMps: 20,
    headingDegrees: 0,
    timestampMs,
    ...extras,
  };
}

function config(overrides: Partial<TrackingConfig> = {}): TrackingConfig {
  return { ...DEFAULT_TRACKING_CONFIG, ...overrides };
}

describe('review: MANUAL_LOCK stays on the selected route', () => {
  it('does not move a manual lock onto another route of the same line', async () => {
    const db = new DualRouteDb([route1, route2]);
    const matcher = new MapMatcher(db, config());
    await matcher.match(sample(35.05, 139.0, 1_000));
    expect(matcher.lockSelectedRoute('route-1-seg', 2_000)).toBe(true);

    db.segments = [route2];
    const next = await matcher.match(sample(35.25, 139.02, 3_000));

    expect(next?.lockState).toBe('MANUAL_LOCK');
    expect(next?.selectedSegment.routeId).toBe('route-1');
    expect(next?.selectedSegment.id).toBe('route-1-seg');
    expect(next?.manualLockAway).toBe(true);
  });

  it('marks the user away when the locked route is outside the search results', async () => {
    const db = new DualRouteDb([route1]);
    const matcher = new MapMatcher(db, config({ routeManualLockMaxDistanceMeters: 80 }));
    await matcher.match(sample(35.05, 139.0, 1_000));
    matcher.lockSelectedRoute('route-1-seg', 2_000);

    db.segments = [];
    const away = await matcher.match(sample(36.0, 140.0, 3_000));
    expect(away?.lockState).toBe('MANUAL_LOCK');
    expect(away?.selectedSegment.id).toBe('route-1-seg');
    expect(away?.manualLockAway).toBe(true);
  });
});

describe('review: manual reacquire uses the GPS window', () => {
  it('keeps window scores on the reacquire path and does not lock on the first fix', async () => {
    const db = new DualRouteDb([route1, route2]);
    const matcher = new MapMatcher(db, config({
      routeRelockConsecutiveCount: 3,
      routeRelockMinimumMs: 3000,
      routeWindowMinSamples: 2,
    }));
    for (let i = 0; i < 4; i++) {
      await matcher.match(sample(35.04 + i * 0.01, 139.0, 10_000 + i * 1000));
    }
    matcher.startManualReacquire(20_000);

    const first = await matcher.match(sample(35.25, 139.02, 21_000));
    expect(first?.lockState).toBe('REACQUIRING');
    expect(first?.windowScores?.some((score) => score.routeId === 'route-2')).toBe(true);
    expect(first?.showSelectedRoute).toBe(false);
  });
});

describe('review: challenger wins must be consecutive', () => {
  it('resets consecutiveWins when the current route wins a fix in between', async () => {
    const other: RailwayLine = { id: 'line-b', operatorId: 'op', name: '在来線B' };
    const otherSeg: TrackSegment = {
      id: 'b-1',
      lineId: other.id,
      routeId: 'route-b',
      fromStationId: 'x',
      toStationId: 'y',
      coordinates: [
        [35.05, 139.008],
        [35.15, 139.008],
      ],
    };
    const db: RailwayDatabaseReader = {
      async findSegmentsNear() {
        return [route1, otherSeg];
      },
      async getLine(id) {
        return id === other.id ? other : LINE;
      },
    };
    const matcher = new MapMatcher(db, config());
    for (let i = 0; i < 4; i++) {
      await matcher.match(sample(35.04, 139.0, 10_000 + i * 1000));
    }

    const win1 = await matcher.match(sample(35.12, 139.008, 20_000));
    expect(win1?.challenger?.consecutiveWins).toBe(1);

    const currentWins = await matcher.match(sample(35.05, 139.0, 21_000));
    expect(currentWins?.challenger).toBeNull();

    const win2 = await matcher.match(sample(35.12, 139.008, 22_000));
    expect(win2?.challenger?.consecutiveWins).toBe(1);
    expect(win2?.lockState).toBe('LOCKED');
  });
});

describe('review: route health uses real topology and trajectory', () => {
  it('does not copy heading into trajectory, and penalizes disconnected segment jumps', () => {
    const observations: RouteObservation[] = [
      {
        timestampMs: 1,
        lineId: LINE.id,
        segmentId: 'a',
        routeId: 'route-1',
        distanceMeters: 12,
        headingDifferenceDegrees: 10,
        trajectoryHeadingDifferenceDegrees: 80,
        trackPositionMeters: 100,
        stationSequence: 1,
        previousSegmentIds: [],
        nextSegmentIds: ['b'],
      },
      {
        timestampMs: 2,
        lineId: LINE.id,
        segmentId: 'z',
        routeId: 'route-1',
        distanceMeters: 14,
        headingDifferenceDegrees: 12,
        trajectoryHeadingDifferenceDegrees: 85,
        trackPositionMeters: 400,
        stationSequence: 2,
        previousSegmentIds: [],
        nextSegmentIds: [],
      },
    ];

    const health = evaluateRouteHealth(observations, null, null, DEFAULT_TRACKING_CONFIG);
    expect(health.trajectoryConsistency).not.toBe(health.headingConsistency);
    expect(health.trajectoryConsistency).toBeLessThan(health.headingConsistency);
    expect(health.topologyConsistency).toBe(0);
    expect(health.stationSequenceConsistency).toBeGreaterThan(0);
  });
});

describe('review: auto-switch stays in REACQUIRING before LOCKED', () => {
  it('does not fully lock a new route on the same fix that switches', async () => {
    const other: RailwayLine = { id: 'line-b', operatorId: 'op', name: '在来線B' };
    const otherSeg: TrackSegment = {
      id: 'b-1',
      lineId: other.id,
      routeId: 'route-b',
      fromStationId: 'x',
      toStationId: 'y',
      coordinates: [
        [35.05, 139.008],
        [35.15, 139.008],
      ],
      startOffsetMeters: 0,
    };
    const db: RailwayDatabaseReader = {
      async findSegmentsNear() {
        return [route1, otherSeg];
      },
      async getLine(id) {
        return id === other.id ? other : LINE;
      },
    };
    const matcher = new MapMatcher(db, config({
      routeSuspiciousMinimumMs: 1000,
      routeReacquireMinimumMs: 1000,
      routeChallengerConsecutiveCount: 2,
      routeChallengerMinimumMs: 1000,
      routeChallengerMinMargin: 5,
      routeRelockConsecutiveCount: 3,
      routeRelockMinimumMs: 2000,
      routeWindowMinSamples: 2,
    }));
    for (let i = 0; i < 4; i++) {
      await matcher.match(sample(35.04, 139.0, 10_000 + i * 1000));
    }

    const states: string[] = [];
    let switchedAt: string | null = null;
    for (let i = 0; i < 8; i++) {
      const result = await matcher.match(sample(35.12 + i * 0.005, 139.008, 20_000 + i * 1000));
      states.push(result?.lockState ?? 'none');
      if (result?.selectedSegment.id === 'b-1' && switchedAt === null) {
        switchedAt = result.lockState ?? null;
      }
    }

    expect(switchedAt).toBe('REACQUIRING');
    expect(states).toContain('REACQUIRING');
  });
});

describe('review: trajectory heading and lock events', () => {
  it('uses movement heading when OS speed is missing but the track has moved', () => {
    const history = [
      sample(35.0, 139.0, 1_000, { speedMps: null, headingDegrees: null }),
      sample(35.001, 139.0, 4_000, { speedMps: null, headingDegrees: null }),
      sample(35.002, 139.0, 7_000, { speedMps: null, headingDegrees: null }),
    ];
    const trajectory = computeTrajectory(history, 7_000, DEFAULT_TRACKING_CONFIG);
    expect(osSpeedStopped(history[2], DEFAULT_TRACKING_CONFIG)).toBeNull();
    expect(trajectory.reliable).toBe(true);
    expect(resolveEffectiveHeading(trajectory, history[2], null)).toBe(trajectory.headingDegrees);
  });

  it('does not treat GPS jitter as a heading while the OS speed says stopped', () => {
    const history = [
      sample(35.0, 139.0, 1_000, { speedMps: 0, headingDegrees: 90 }),
      sample(35.0002, 139.0, 2_000, { speedMps: 0, headingDegrees: 90 }),
    ];
    const trajectory = computeTrajectory(history, 2_000, {
      ...DEFAULT_TRACKING_CONFIG,
      routeTrajectoryMinDistanceMeters: 5,
    });
    const heading = resolveEffectiveHeading(trajectory, history[1], true);
    expect(heading).toBe(90);
  });

  it('includes a manual-reacquire event on the next match', async () => {
    const db = new DualRouteDb([route1]);
    const matcher = new MapMatcher(db, config());
    await matcher.match(sample(35.05, 139.0, 1_000));
    matcher.startManualReacquire(2_000);
    const next = await matcher.match(sample(35.05, 139.0, 3_000));
    expect(next?.lockEvents?.some((event) => event.type === 'manual-reacquire')).toBe(true);
  });
});

describe('review: window topology is not always 1', () => {
  it('scores a disconnected jump lower than a continuous segment', () => {
    const history = [
      sample(35.05, 139.0, 1_000),
      sample(35.25, 139.02, 2_000),
      sample(35.28, 139.02, 3_000),
    ];
    const scores = scoreRoutesOverWindow(
      history,
      [
        { routeId: 'route-1', line: LINE, segments: [route1] },
        { routeId: 'route-2', line: LINE, segments: [route2] },
      ],
      DEFAULT_TRACKING_CONFIG
    );
    const mixed = scoreRoutesOverWindow(
      history,
      [{ routeId: 'mixed', line: LINE, segments: [route1, route2] }],
      DEFAULT_TRACKING_CONFIG
    );
    expect(scores[0].topologyScore).toBeGreaterThan(0);
    expect(mixed[0].topologyScore).toBeLessThan(1);
  });
});
