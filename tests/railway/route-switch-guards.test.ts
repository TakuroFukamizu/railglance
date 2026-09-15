import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACKING_CONFIG, TrackingConfig } from '../../src/config/tracking-config';
import { LocationSample } from '../../src/domain/models/location';
import { RailwayLine, TrackSegment } from '../../src/domain/models/railway';
import { MapMatcher, RailwayDatabaseReader } from '../../src/domain/railway/map-matcher';

const LINE_A: RailwayLine = { id: 'line-a', operatorId: 'op', name: '在来線A' };
const LINE_B: RailwayLine = { id: 'line-b', operatorId: 'op', name: '在来線B' };

const segA: TrackSegment = {
  id: 'a-1',
  lineId: LINE_A.id,
  routeId: 'route-a',
  fromStationId: 'st-1',
  toStationId: 'st-2',
  coordinates: [
    [35.0, 139.0],
    [35.1, 139.0],
  ],
  startOffsetMeters: 0,
};

const segB: TrackSegment = {
  id: 'b-1',
  lineId: LINE_B.id,
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
    return [segA, segB];
  },
  async getLine(id) {
    return id === LINE_B.id ? LINE_B : LINE_A;
  },
};

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

async function lockOnA(matcher: MapMatcher): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await matcher.match(sample(35.04, 139.0, 10_000 + i * 1000));
  }
}

describe('guard: a freshly switched route is confirmed over several fixes', () => {
  it('does not lock the new route on the fix after the switch on default-built health', async () => {
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
    await lockOnA(matcher);

    const ticks: Array<{ segmentId: string | undefined; state: string | undefined; atMs: number }> = [];
    for (let i = 0; i < 10; i++) {
      const atMs = 20_000 + i * 1000;
      const result = await matcher.match(sample(35.12 + i * 0.001, 139.008, atMs));
      ticks.push({ segmentId: result?.selectedSegment.id, state: result?.lockState, atMs });
    }

    const switchIndex = ticks.findIndex((tick) => tick.segmentId === 'b-1');
    expect(switchIndex).toBeGreaterThanOrEqual(0);
    expect(ticks[switchIndex].state).toBe('REACQUIRING');
    const lockIndex = ticks.findIndex((tick, index) => index > switchIndex && tick.state === 'LOCKED');
    expect(lockIndex).toBeGreaterThan(switchIndex);
    // Confirmation needs routeRelockConsecutiveCount fixes spanning routeRelockMinimumMs.
    expect(lockIndex - switchIndex + 1).toBeGreaterThanOrEqual(3);
    expect(ticks[lockIndex].atMs - ticks[switchIndex].atMs).toBeGreaterThanOrEqual(2000);
    expect(ticks[lockIndex].segmentId).toBe('b-1');
  });
});

describe('guard: a stop neither adds nor resets challenger wins', () => {
  it('freezes consecutiveWins while the OS reports stopped', async () => {
    const matcher = new MapMatcher(db, config());
    await lockOnA(matcher);

    expect((await matcher.match(sample(35.12, 139.008, 20_000)))?.challenger?.consecutiveWins).toBe(1);
    expect((await matcher.match(sample(35.121, 139.008, 21_000)))?.challenger?.consecutiveWins).toBe(2);

    // Stopped on the challenger: no win is added.
    const stoppedOnChallenger = await matcher.match(sample(35.121, 139.008, 22_000, { speedMps: 0 }));
    expect(stoppedOnChallenger?.challenger?.consecutiveWins).toBe(2);

    // Stopped where the locked route wins: the challenger is not reset either.
    const stoppedOnCurrent = await matcher.match(sample(35.05, 139.0, 23_000, { speedMps: 0 }));
    expect(stoppedOnCurrent?.challenger?.consecutiveWins).toBe(2);
    expect(stoppedOnCurrent?.lockState).toBe('LOCKED');

    const movingAgain = await matcher.match(sample(35.122, 139.008, 24_000));
    expect(movingAgain?.challenger?.consecutiveWins).toBe(3);
  });

  it('does not count a dwell toward the challenger minimum duration', async () => {
    const matcher = new MapMatcher(db, config());
    await lockOnA(matcher);
    const dominant = () => (matcher as unknown as { challengerDominant(): boolean }).challengerDominant();

    await matcher.match(sample(35.12, 139.008, 20_000));
    await matcher.match(sample(35.121, 139.008, 21_000));
    // Stopped where the locked route wins.
    for (const atMs of [22_000, 23_000, 24_000]) {
      await matcher.match(sample(35.05, 139.0, atMs, { speedMps: 0 }));
    }
    const afterDwell = await matcher.match(sample(35.122, 139.008, 25_000));

    expect(afterDwell?.challenger?.consecutiveWins).toBe(3);
    // Only ~2 s of moving evidence: below routeChallengerMinimumMs (4000).
    const challenger = afterDwell!.challenger!;
    expect(challenger.lastSeenAtMs - challenger.firstSeenAtMs).toBeLessThan(DEFAULT_TRACKING_CONFIG.routeChallengerMinimumMs);
    expect(dominant()).toBe(false);
  });

  it('does not let a long stop make the challenger dominant on the first moving fix', async () => {
    const matcher = new MapMatcher(db, config());
    await lockOnA(matcher);
    const dominant = () => (matcher as unknown as { challengerDominant(): boolean }).challengerDominant();

    await matcher.match(sample(35.12, 139.008, 20_000));
    await matcher.match(sample(35.121, 139.008, 21_000));
    await matcher.match(sample(35.121, 139.008, 22_000, { speedMps: 0 }));
    await matcher.match(sample(35.121, 139.008, 61_000, { speedMps: 0 }));
    await matcher.match(sample(35.122, 139.008, 62_000));

    expect(dominant()).toBe(false);
  });

  it('still makes a challenger dominant after enough moving wins spanning the minimum duration', async () => {
    const matcher = new MapMatcher(db, config());
    await lockOnA(matcher);
    const dominant = () => (matcher as unknown as { challengerDominant(): boolean }).challengerDominant();

    const flags: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      await matcher.match(sample(35.12 + i * 0.001, 139.008, 20_000 + i * 1000));
      flags.push(dominant());
    }
    // 3 wins over 2 s is not enough; 5 wins over 4 s is.
    expect(flags[2]).toBe(false);
    expect(flags[4]).toBe(true);
  });

  it('keeps counting when the OS speed is unknown (GPS loss does not freeze switching)', async () => {
    const matcher = new MapMatcher(db, config());
    await lockOnA(matcher);

    await matcher.match(sample(35.12, 139.008, 20_000));
    const unknownSpeed = await matcher.match(sample(35.12, 139.008, 21_000, { speedMps: null, headingDegrees: null }));
    expect(unknownSpeed?.challenger?.consecutiveWins).toBe(2);
  });
});
