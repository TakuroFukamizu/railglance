import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_TRACKING_CONFIG, TrackingConfig } from '../../src/config/tracking-config';
import { MapMatcher, RailwayDatabaseReader } from '../../src/domain/railway/map-matcher';
import { RailwayLine, TrackSegment } from '../../src/domain/models/railway';
import { LocationSample } from '../../src/domain/models/location';
import { scoreCandidate } from '../../src/domain/railway/candidate-scorer';

const LINE_A: RailwayLine = { id: 'line-a', operatorId: 'op', name: '在来線A' };
const LINE_B: RailwayLine = { id: 'line-b', operatorId: 'op', name: '在来線B' };
const SHINKANSEN: RailwayLine = { id: 'line-shinkansen', operatorId: 'jre', name: 'JR東北新幹線' };

const segA1: TrackSegment = {
  id: 'seg-a-1',
  lineId: 'line-a',
  routeId: 'route-a',
  fromStationId: 'st-1',
  toStationId: 'st-2',
  coordinates: [
    [35.0, 139.0],
    [35.1, 139.0],
  ],
  lengthMeters: 11120,
  startOffsetMeters: 0,
  nextSegmentIds: ['seg-a-2'],
};

const segA2: TrackSegment = {
  id: 'seg-a-2',
  lineId: 'line-a',
  routeId: 'route-a',
  fromStationId: 'st-2',
  toStationId: 'st-3',
  coordinates: [
    [35.1, 139.0],
    [35.2, 139.0],
  ],
  lengthMeters: 11120,
  startOffsetMeters: 11120,
  previousSegmentIds: ['seg-a-1'],
};

const segB1: TrackSegment = {
  id: 'seg-b-1',
  lineId: 'line-b',
  routeId: 'route-b',
  fromStationId: 'st-x',
  toStationId: 'st-y',
  coordinates: [
    [35.05, 139.008],
    [35.15, 139.008],
  ],
  lengthMeters: 11120,
  startOffsetMeters: 0,
};

class MockRailwayDatabase implements RailwayDatabaseReader {
  public segments: TrackSegment[] = [segA1, segA2, segB1];
  public lines = new Map<string, RailwayLine>([
    [LINE_A.id, LINE_A],
    [LINE_B.id, LINE_B],
    [SHINKANSEN.id, SHINKANSEN],
  ]);

  async findSegmentsNear(): Promise<TrackSegment[]> {
    return this.segments;
  }

  async getLine(lineId: string): Promise<RailwayLine | undefined> {
    return this.lines.get(lineId);
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

async function lockOnA(matcher: MapMatcher, startMs = 10_000): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await matcher.match(sample(35.04, 139.0, startMs + i * 1000));
  }
}

describe('MapMatcher initial lock', () => {
  let db: MockRailwayDatabase;
  let matcher: MapMatcher;

  beforeEach(() => {
    db = new MockRailwayDatabase();
    matcher = new MapMatcher(db, config());
  });

  it('does not lock after a single GPS fix', async () => {
    const match = await matcher.match(sample(35.05, 139.0, 10_000));
    expect(match).not.toBeNull();
    expect(match?.lockState).toBe('UNRESOLVED');
    expect(match?.showSelectedRoute).toBe(false);
    expect(match?.selectedSegment.id).toBe('seg-a-1');
  });

  it('locks after the same candidate stays ahead across enough fixes', async () => {
    let last = await matcher.match(sample(35.04, 139.0, 10_000));
    last = await matcher.match(sample(35.045, 139.0, 11_000));
    last = await matcher.match(sample(35.05, 139.0, 12_000));
    last = await matcher.match(sample(35.055, 139.0, 13_000));

    expect(last?.lockState).toBe('LOCKED');
    expect(last?.selectedLine.id).toBe('line-a');
    expect(last?.showSelectedRoute).toBe(true);
    expect(last?.lockEvents?.some((event) => event.type === 'route-lock')).toBe(true);
  });

  it('stays unresolved when top and second scores are too close', async () => {
    db.segments = [
      segA1,
      {
        ...segB1,
        coordinates: [
          [35.0, 139.0004],
          [35.1, 139.0004],
        ],
      },
    ];

    let last = null;
    for (let i = 0; i < 5; i++) {
      last = await matcher.match(sample(35.05, 139.0002, 10_000 + i * 1000));
    }

    expect(last?.lockState).toBe('UNRESOLVED');
    expect(last?.scoreMargin ?? 99).toBeLessThan(DEFAULT_TRACKING_CONFIG.routeInitialLockMinMargin);
  });

  it('does not immediately lock a wrong route while stopped', async () => {
    const match = await matcher.match(sample(35.05, 139.0, 10_000, { speedMps: 0, headingDegrees: null }));
    expect(match?.lockState).toBe('UNRESOLVED');
    expect(match?.showSelectedRoute).toBe(false);
  });
});

describe('MapMatcher current rescore', () => {
  it('compares the challenger against the current route rescored at this fix', async () => {
    const db = new MockRailwayDatabase();
    const matcher = new MapMatcher(db, config());
    await lockOnA(matcher);

    const next = await matcher.match(sample(35.16, 139.0, 20_000));
    expect(next?.lockState).toBe('LOCKED');
    expect(next?.rescoredCurrentScore).not.toBeNull();
    expect(next?.selectedLine.id).toBe('line-a');
    expect(next?.selectedSegment.id).toBe('seg-a-2');
  });

  it('treats a current route that left the search radius as lost evidence', async () => {
    const db = new MockRailwayDatabase();
    const matcher = new MapMatcher(db, config({
      routeSuspiciousMinimumMs: 0,
      routeReacquireMinimumMs: 0,
    }));
    await lockOnA(matcher);

    db.segments = [segB1];
    const lost = await matcher.match(sample(35.12, 139.008, 20_000));
    expect(lost?.lockState === 'SUSPICIOUS' || lost?.lockState === 'REACQUIRING').toBe(true);
    expect(lost?.rescoredCurrentScore ?? null).toBeNull();
  });
});

describe('MapMatcher continuity and health', () => {
  it('gives the highest continuity bonus to the same segment', () => {
    const same = scoreCandidate({
      sample: sample(35.05, 139.0, 1),
      segment: segA1,
      line: LINE_A,
      previousSegment: segA1,
      nearbySegments: [segA1, segA2],
      lockState: 'LOCKED',
      effectiveHeadingDegrees: 0,
      config: DEFAULT_TRACKING_CONFIG,
    });
    const adjacent = scoreCandidate({
      sample: sample(35.11, 139.0, 1),
      segment: segA2,
      line: LINE_A,
      previousSegment: segA1,
      nearbySegments: [segA1, segA2],
      lockState: 'LOCKED',
      effectiveHeadingDegrees: 0,
      config: DEFAULT_TRACKING_CONFIG,
    });
    const otherLine = scoreCandidate({
      sample: sample(35.05, 139.008, 1),
      segment: segB1,
      line: LINE_B,
      previousSegment: segA1,
      nearbySegments: [segA1, segA2, segB1],
      lockState: 'LOCKED',
      effectiveHeadingDegrees: 0,
      config: DEFAULT_TRACKING_CONFIG,
    });

    expect(same.continuityScore).toBe(DEFAULT_TRACKING_CONFIG.continuitySameSegment);
    expect(adjacent.continuityScore).toBe(DEFAULT_TRACKING_CONFIG.continuityAdjacentSegment);
    expect(otherLine.continuityScore).toBe(0);
    expect(same.continuityScore).toBeGreaterThan(adjacent.continuityScore);
  });

  it('reduces continuity bias while suspicious and almost removes it while reacquiring', () => {
    const locked = scoreCandidate({
      sample: sample(35.05, 139.0, 1),
      segment: segA1,
      line: LINE_A,
      previousSegment: segA1,
      nearbySegments: [segA1],
      lockState: 'LOCKED',
      effectiveHeadingDegrees: 0,
      config: DEFAULT_TRACKING_CONFIG,
    });
    const suspicious = scoreCandidate({
      sample: sample(35.05, 139.0, 1),
      segment: segA1,
      line: LINE_A,
      previousSegment: segA1,
      nearbySegments: [segA1],
      lockState: 'SUSPICIOUS',
      effectiveHeadingDegrees: 0,
      config: DEFAULT_TRACKING_CONFIG,
    });
    const reacquiring = scoreCandidate({
      sample: sample(35.05, 139.0, 1),
      segment: segA1,
      line: LINE_A,
      previousSegment: segA1,
      nearbySegments: [segA1],
      lockState: 'REACQUIRING',
      effectiveHeadingDegrees: 0,
      config: DEFAULT_TRACKING_CONFIG,
    });

    expect(suspicious.continuityScore).toBeLessThan(locked.continuityScore);
    expect(reacquiring.continuityScore).toBeLessThan(suspicious.continuityScore);
    expect(reacquiring.continuityScore).toBeLessThanOrEqual(2);
  });

  it('does not penalize a shinkansen for being slow, but penalizes conventional lines at 250 km/h', () => {
    const fastConventional = scoreCandidate({
      sample: sample(35.05, 139.0, 1, { speedMps: 250 / 3.6 }),
      segment: segA1,
      line: LINE_A,
      previousSegment: null,
      nearbySegments: [segA1],
      lockState: 'UNRESOLVED',
      effectiveHeadingDegrees: 0,
      config: DEFAULT_TRACKING_CONFIG,
    });
    const slowShinkansen = scoreCandidate({
      sample: sample(35.05, 139.0, 1, { speedMps: 5 / 3.6 }),
      segment: { ...segA1, id: 'shin-1', lineId: SHINKANSEN.id },
      line: SHINKANSEN,
      previousSegment: null,
      nearbySegments: [segA1],
      lockState: 'UNRESOLVED',
      effectiveHeadingDegrees: 0,
      config: DEFAULT_TRACKING_CONFIG,
    });
    const slowConventional = scoreCandidate({
      sample: sample(35.05, 139.0, 1, { speedMps: 5 / 3.6 }),
      segment: segA1,
      line: LINE_A,
      previousSegment: null,
      nearbySegments: [segA1],
      lockState: 'UNRESOLVED',
      effectiveHeadingDegrees: 0,
      config: DEFAULT_TRACKING_CONFIG,
    });

    expect(fastConventional.totalScore).toBeLessThan(slowConventional.totalScore);
    expect(slowShinkansen.totalScore).toBeGreaterThan(fastConventional.totalScore - 5);
  });
});

describe('MapMatcher challenger and health recovery', () => {
  it('does not switch after a single high-scoring challenger fix', async () => {
    const db = new MockRailwayDatabase();
    const matcher = new MapMatcher(db, config());
    await lockOnA(matcher);

    const spike = await matcher.match(sample(35.12, 139.008, 20_000));
    expect(spike?.selectedLine.id).toBe('line-a');
    expect(spike?.lockState).toBe('LOCKED');
    expect(spike?.challenger?.lineId).toBe('line-b');
    expect(spike?.challenger?.consecutiveWins).toBe(1);
  });

  it('tracks a persistent challenger without switching while current health stays healthy', async () => {
    const db = new MockRailwayDatabase();
    const matcher = new MapMatcher(db, config({
      routeChallengerConsecutiveCount: 2,
      routeChallengerMinimumMs: 1000,
    }));
    await lockOnA(matcher);

    // Stay on line A, even if B is briefly closer, because health remains high on A.
    await matcher.match(sample(35.06, 139.001, 20_000));
    const stillA = await matcher.match(sample(35.07, 139.001, 21_000));
    expect(stillA?.selectedLine.id).toBe('line-a');
    expect(stillA?.lockState).toBe('LOCKED');
  });

  it('switches only when health is low, the challenger is clearly better, and that persists', async () => {
    const db = new MockRailwayDatabase();
    const matcher = new MapMatcher(db, config({
      routeSuspiciousMinimumMs: 1000,
      routeReacquireMinimumMs: 1000,
      routeChallengerConsecutiveCount: 2,
      routeChallengerMinimumMs: 1000,
      routeChallengerMinMargin: 5,
      routeRelockConsecutiveCount: 2,
      routeRelockMinimumMs: 1000,
      routeWindowMinSamples: 2,
    }));
    await lockOnA(matcher);

    let last = null;
    for (let i = 0; i < 8; i++) {
      last = await matcher.match(sample(35.12 + i * 0.005, 139.008, 20_000 + i * 1000));
    }

    expect(last?.lockState).toBe('LOCKED');
    expect(last?.selectedLine.id).toBe('line-b');
    expect(last?.switchReason).toBe('challenger-dominant');
  });
});

describe('MapMatcher manual reacquire and lock', () => {
  it('clears continuity bias and re-evaluates the GPS window after a manual reacquire', async () => {
    const db = new MockRailwayDatabase();
    const matcher = new MapMatcher(db, config({
      routeRelockConsecutiveCount: 2,
      routeRelockMinimumMs: 1000,
      routeWindowMinSamples: 2,
      routeInitialLockMinMargin: 5,
    }));
    await lockOnA(matcher);
    expect(matcher.getLockState()).toBe('LOCKED');

    matcher.startManualReacquire(20_000);
    expect(matcher.getLockState()).toBe('REACQUIRING');

    const first = await matcher.match(sample(35.12, 139.008, 21_000));
    expect(first?.lockState).toBe('REACQUIRING');
    expect(first?.showSelectedRoute).toBe(false);
    expect(first?.candidates[0]?.continuityScore ?? 99).toBeLessThan(2);

    await matcher.match(sample(35.13, 139.008, 22_000));
    const locked = await matcher.match(sample(35.14, 139.008, 23_000));
    expect(locked?.lockState).toBe('LOCKED');
    expect(locked?.selectedLine.id).toBe('line-b');
  });

  it('prioritizes a user-selected route and warns when the user is far from it', async () => {
    const db = new MockRailwayDatabase();
    const matcher = new MapMatcher(db, config({ routeManualLockMaxDistanceMeters: 80 }));
    await matcher.match(sample(35.05, 139.0, 10_000));
    expect(matcher.lockSelectedRoute('seg-b-1', 11_000)).toBe(true);

    const locked = await matcher.match(sample(35.05, 139.0, 12_000));
    expect(locked?.lockState).toBe('MANUAL_LOCK');
    expect(locked?.selectedLine.id).toBe('line-b');
    expect(locked?.manualLockAway).toBe(true);

    const stillB = await matcher.match(sample(35.06, 139.0, 13_000));
    expect(stillB?.selectedLine.id).toBe('line-b');
  });

  it('returns to unresolved auto matching when the user unlocks a manual lock', async () => {
    const db = new MockRailwayDatabase();
    const matcher = new MapMatcher(db, config());
    await matcher.match(sample(35.05, 139.0, 10_000));
    matcher.lockSelectedRoute('seg-a-1', 11_000);

    matcher.unlockManualRoute(12_000);
    const next = await matcher.match(sample(35.05, 139.0, 13_000));
    expect(next?.lockState).toBe('UNRESOLVED');
    expect(next?.showSelectedRoute).toBe(false);
  });
});
