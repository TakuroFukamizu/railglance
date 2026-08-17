import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACKING_CONFIG, TrackingConfig } from '../../src/config/tracking-config';
import { LocationSample } from '../../src/domain/models/location';
import { RailwayLine, RouteCandidateScore, TrackSegment } from '../../src/domain/models/railway';
import { MapMatcher, RailwayDatabaseReader } from '../../src/domain/railway/map-matcher';
import { scoreCandidate } from '../../src/domain/railway/candidate-scorer';

const SOBU: RailwayLine = {
  id: 'jreast-chuo-sobu-local',
  operatorId: 'jreast',
  name: 'JR中央・総武線各駅停車',
};

const SHINKANSEN: RailwayLine = {
  id: 'jreast-tohoku-shinkansen',
  operatorId: 'jreast',
  name: 'JR東北新幹線',
};

const sobuSegment: TrackSegment = {
  id: 'sobu-asakusabashi-akihabara',
  lineId: SOBU.id,
  routeId: 'route-sobu-west',
  fromStationId: 'asakusabashi',
  toStationId: 'akihabara',
  coordinates: [
    [35.6968, 139.7900],
    [35.6972, 139.7864],
    [35.6978, 139.7800],
    [35.6983, 139.7730],
    [35.6990, 139.7680],
  ],
  lengthMeters: 2000,
  startOffsetMeters: 12300,
};

const shinkansenSegment: TrackSegment = {
  id: 'tohoku-tokyo-ueno',
  lineId: SHINKANSEN.id,
  routeId: 'route-tohoku-north',
  fromStationId: 'tokyo',
  toStationId: 'ueno',
  coordinates: [
    [35.6812, 139.7671],
    [35.6900, 139.7700],
    [35.6980, 139.7735],
    [35.7141, 139.7774],
  ],
  lengthMeters: 3700,
  startOffsetMeters: 2100,
};

class TokyoEastDb implements RailwayDatabaseReader {
  async findSegmentsNear(): Promise<TrackSegment[]> {
    return [sobuSegment, shinkansenSegment];
  }
  async getLine(lineId: string): Promise<RailwayLine | undefined> {
    if (lineId === SOBU.id) return SOBU;
    if (lineId === SHINKANSEN.id) return SHINKANSEN;
    return undefined;
  }
}

const config: TrackingConfig = {
  ...DEFAULT_TRACKING_CONFIG,
  routeInitialLockConsecutiveCount: 3,
  routeInitialLockMinimumMs: 2000,
  routeSuspiciousMinimumMs: 1500,
  routeReacquireMinimumMs: 1500,
  routeChallengerConsecutiveCount: 2,
  routeChallengerMinimumMs: 1500,
  routeChallengerMinMargin: 6,
  routeRelockConsecutiveCount: 2,
  routeRelockMinimumMs: 1500,
  routeWindowMinSamples: 3,
};

function point(lat: number, lon: number, timestampMs: number, extras: Partial<LocationSample> = {}): LocationSample {
  return {
    latitude: lat,
    longitude: lon,
    accuracyMeters: 12,
    speedMps: 12,
    headingDegrees: extras.headingDegrees ?? 275,
    timestampMs,
    ...extras,
  };
}

/** GPS error near the Shinkansen, then a westbound Sobu run Asakusabashi -> Akihabara. */
const ASAKUSABASHI_TO_AKIHABARA: LocationSample[] = [
  point(35.6976, 139.7740, 1_000, { headingDegrees: 10 }),
  point(35.6974, 139.7748, 2_000, { headingDegrees: 350 }),
  point(35.6972, 139.7864, 3_000),
  point(35.6974, 139.7840, 4_000),
  point(35.6976, 139.7815, 5_000),
  point(35.6978, 139.7790, 6_000),
  point(35.6980, 139.7765, 7_000),
  point(35.6983, 139.7730, 8_000),
  point(35.6986, 139.7708, 9_000),
  point(35.6990, 139.7680, 10_000),
  point(35.6992, 139.7665, 11_000),
  point(35.6994, 139.7650, 12_000),
];

const TOKYO_TO_UENO_SHINKANSEN: LocationSample[] = [
  point(35.6820, 139.7674, 1_000, { speedMps: 20, headingDegrees: 20 }),
  point(35.6860, 139.7688, 2_000, { speedMps: 40, headingDegrees: 18 }),
  point(35.6900, 139.7700, 3_000, { speedMps: 55, headingDegrees: 16 }),
  point(35.6940, 139.7718, 4_000, { speedMps: 60, headingDegrees: 15 }),
  point(35.6980, 139.7735, 5_000, { speedMps: 58, headingDegrees: 14 }),
  point(35.7060, 139.7754, 6_000, { speedMps: 62, headingDegrees: 14 }),
  point(35.7120, 139.7768, 7_000, { speedMps: 45, headingDegrees: 13 }),
];

function shinkansenScore(sample: LocationSample): RouteCandidateScore {
  return scoreCandidate({
    sample,
    segment: shinkansenSegment,
    line: SHINKANSEN,
    previousSegment: shinkansenSegment,
    nearbySegments: [sobuSegment, shinkansenSegment],
    lockState: 'LOCKED',
    effectiveHeadingDegrees: sample.headingDegrees,
    config,
  });
}

describe('Asakusabashi / Chuo-Sobu misclassification fixture', () => {
  it('does not immediately lock the Tohoku Shinkansen when it is briefly the top candidate', async () => {
    const matcher = new MapMatcher(new TokyoEastDb(), config);

    const first = await matcher.match(ASAKUSABASHI_TO_AKIHABARA[0]);
    expect(first?.lockState).toBe('UNRESOLVED');

    const second = await matcher.match(ASAKUSABASHI_TO_AKIHABARA[1]);
    expect(second?.lockState).toBe('UNRESOLVED');

    let last = second;
    for (const sample of ASAKUSABASHI_TO_AKIHABARA.slice(2)) {
      last = await matcher.match(sample);
    }

    expect(last?.lockState).toBe('LOCKED');
    expect(last?.selectedLine.id).toBe(SOBU.id);
  });

  it('recovers from a wrong Shinkansen lock while riding Asakusabashi to Akihabara', async () => {
    const matcher = new MapMatcher(new TokyoEastDb(), config);
    matcher.forceLockForTests(shinkansenScore(ASAKUSABASHI_TO_AKIHABARA[0]));
    expect(matcher.getLockState()).toBe('LOCKED');

    const states: string[] = [];
    let last = null;
    for (const sample of ASAKUSABASHI_TO_AKIHABARA) {
      last = await matcher.match(sample);
      if (last?.lockState) states.push(last.lockState);
    }

    expect(states).toContain('SUSPICIOUS');
    expect(states).toContain('REACQUIRING');
    expect(last?.lockState).toBe('LOCKED');
    expect(last?.selectedLine.id).toBe(SOBU.id);
  });

  it('does not flicker away from a healthy Chuo-Sobu lock when a parallel candidate spikes', async () => {
    const matcher = new MapMatcher(new TokyoEastDb(), config);
    for (const sample of ASAKUSABASHI_TO_AKIHABARA.slice(2, 6)) {
      await matcher.match(sample);
    }
    expect(matcher.getLockState()).toBe('LOCKED');

    const spike = await matcher.match(point(35.6979, 139.7736, 20_000, { headingDegrees: 15 }));
    expect(spike?.selectedLine.id).toBe(SOBU.id);
    expect(spike?.lockState).toBe('LOCKED');

    const after = await matcher.match(point(35.6981, 139.7750, 21_000));
    expect(after?.selectedLine.id).toBe(SOBU.id);
    expect(after?.lockState).toBe('LOCKED');
  });

  it('still locks the Tohoku Shinkansen on a real Tokyo-Ueno run', async () => {
    const matcher = new MapMatcher(new TokyoEastDb(), config);
    let last = null;
    for (const sample of TOKYO_TO_UENO_SHINKANSEN) {
      last = await matcher.match(sample);
    }
    expect(last?.lockState).toBe('LOCKED');
    expect(last?.selectedLine.id).toBe(SHINKANSEN.id);
  });
});
