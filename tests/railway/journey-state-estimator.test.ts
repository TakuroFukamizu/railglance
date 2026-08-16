import { describe, it, expect } from 'vitest';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import {
  computeSegmentProgress,
  isDownDirection,
  isUpDirection,
  JourneyStateEstimator,
} from '../../src/domain/railway/journey-state-estimator';
import { haversineDistance } from '../../src/domain/geo/distance';
import { RailwayCoverageResult, RailwayDataRepository, RailwayDataState } from '../../src/domain/railway/repository';
import { RailwayLine, RailwayRoute, RouteMatch, Station, TrackSegment } from '../../src/domain/models/railway';
import {
  LocationSample,
  FullSpeedState,
  SpeedEstimate,
  TrackNavigationState,
} from '../../src/domain/models/location';

class MockStationDatabase implements RailwayDataRepository {
  private stations: Station[] = [
    { id: 'st-1', lineId: 'line-1', name: '海老名', sequence: 1, latitude: 35.4526, longitude: 139.3900 },
    { id: 'st-2', lineId: 'line-1', name: '座間', sequence: 2, latitude: 35.4806, longitude: 139.4005 },
    { id: 'st-3', lineId: 'line-1', name: '相武台前', sequence: 3, latitude: 35.4988, longitude: 139.4144 },
  ];

  async ensureCoverageAround(): Promise<RailwayCoverageResult> {
    return { state: 'bundled', loadedTileCount: 0 };
  }
  async findSegmentsNear(): Promise<TrackSegment[]> {
    return [];
  }
  async getLine(lineId: string): Promise<RailwayLine | undefined> {
    return { id: lineId, operatorId: 'odakyu', name: '小田急線', directionAName: '上り', directionBName: '下り' };
  }
  async getRoute(): Promise<RailwayRoute | undefined> {
    return undefined;
  }
  async getStation(id: string): Promise<Station | undefined> {
    return this.stations.find((s) => s.id === id);
  }
  async getStationsByLine(): Promise<Station[]> {
    return this.stations;
  }
  async getSegmentsByRoute(): Promise<TrackSegment[]> {
    return [];
  }
  getDataState(): RailwayDataState {
    return 'bundled';
  }
}

describe('JourneyStateEstimator', () => {
  it('correctly estimates UP direction when heading towards increasing sequence stations', async () => {
    const db = new MockStationDatabase();
    const estimator = new JourneyStateEstimator(db, DEFAULT_TRACKING_CONFIG);

    const line: RailwayLine = { id: 'line-1', operatorId: 'odakyu', name: '小田急線', directionAName: '内回り', directionBName: '外回り' };
    const seg: TrackSegment = {
      id: 'seg-1',
      lineId: 'line-1',
      fromStationId: 'st-1', // Ebina (seq 1)
      toStationId: 'st-2',   // Zama (seq 2)
      coordinates: [
        [35.4526, 139.3900],
        [35.4806, 139.4005],
      ],
      lengthMeters: 3200,
      startOffsetMeters: 0,
    };

    const match: RouteMatch = {
      selectedLine: line,
      selectedSegment: seg,
      confidence: 0.9,
      candidates: [],
      timestampMs: 10000,
    };

    // Train traveling North-East (towards Zama / Shinjuku) at heading 30 deg
    const sample: LocationSample = {
      latitude: 35.4660,
      longitude: 139.3950,
      accuracyMeters: 10,
      speedMps: 25,
      headingDegrees: 30,
      timestampMs: 10000,
    };

    const selectedEst: SpeedEstimate = {
      speedKmh: 90,
      confidence: 0.9,
      source: 'os-geolocation',
      timestamp: 10000,
    };

    const speedState: FullSpeedState = {
      selectedEstimate: selectedEst,
      smoothedSpeedKmh: 90,
      isStopped: false,
      isValid: true,
      candidates: {
        osSpeed: selectedEst,
        positionDeltaSpeed: null,
        trackDistanceSpeed: null,
        deadReckoningSpeed: null,
        sensorFusionSpeed: null,
      },
      navState: {
        lineId: 'line-1',
        routeId: null,
        segmentId: 'seg-1',
        direction: 'UP',
        trackPositionMeters: 1500,
        velocityMps: 25,
        accelerationMps2: 0,
        accelerationBiasMps2: 0,
        lastObservationTimestampMs: 10000,
        lastPredictionTimestampMs: 10000,
        mode: 'gps-locked',
        confidence: 0.9,
      },
    };

    const state = await estimator.update(sample, match, speedState);

    expect(state.direction).toBe('UP');
    expect(state.directionName).toBe('内回り');
    expect(state.previousStation?.name).toBe('海老名');
    expect(state.nextStation?.name).toBe('座間');
    expect(state.status).toBe('TRACKING');
  });

  it('correctly estimates DOWN direction when heading towards decreasing sequence stations', async () => {
    const db = new MockStationDatabase();
    const estimator = new JourneyStateEstimator(db, DEFAULT_TRACKING_CONFIG);

    const line: RailwayLine = { id: 'line-1', operatorId: 'odakyu', name: '小田急線', directionAName: '内回り', directionBName: '外回り' };
    const seg: TrackSegment = {
      id: 'seg-1',
      lineId: 'line-1',
      fromStationId: 'st-1', // Ebina (seq 1)
      toStationId: 'st-2',   // Zama (seq 2)
      coordinates: [
        [35.4526, 139.3900],
        [35.4806, 139.4005],
      ],
      lengthMeters: 3200,
      startOffsetMeters: 0,
    };

    const match: RouteMatch = {
      selectedLine: line,
      selectedSegment: seg,
      confidence: 0.9,
      candidates: [],
      timestampMs: 10000,
    };

    // Train traveling South-West (towards Ebina / Odawara) at heading 210 deg (opposite vector)
    const sample: LocationSample = {
      latitude: 35.4660,
      longitude: 139.3950,
      accuracyMeters: 10,
      speedMps: 25,
      headingDegrees: 210,
      timestampMs: 10000,
    };

    const selectedEst: SpeedEstimate = {
      speedKmh: 90,
      confidence: 0.9,
      source: 'os-geolocation',
      timestamp: 10000,
    };

    const speedState: FullSpeedState = {
      selectedEstimate: selectedEst,
      smoothedSpeedKmh: 90,
      isStopped: false,
      isValid: true,
      candidates: {
        osSpeed: selectedEst,
        positionDeltaSpeed: null,
        trackDistanceSpeed: null,
        deadReckoningSpeed: null,
        sensorFusionSpeed: null,
      },
      navState: {
        lineId: 'line-1',
        routeId: null,
        segmentId: 'seg-1',
        direction: 'DOWN',
        trackPositionMeters: 1500,
        velocityMps: 25,
        accelerationMps2: 0,
        accelerationBiasMps2: 0,
        lastObservationTimestampMs: 10000,
        lastPredictionTimestampMs: 10000,
        mode: 'gps-locked',
        confidence: 0.9,
      },
    };

    const state = await estimator.update(sample, match, speedState);

    expect(state.direction).toBe('DOWN');
    expect(state.directionName).toBe('外回り');
    expect(state.previousStation?.name).toBe('座間');
    expect(state.nextStation?.name).toBe('海老名');
    expect(state.distanceToNextStationMeters).toBe(1500);
    expect(state.progressRatio).toBe(1700 / 3200);
    expect(state.status).toBe('TRACKING');
  });
});

// 上り: st-1(海老名) -> st-2(座間) -> st-3(相武台前)
// 下り: st-3 -> st-2 -> st-1
// トラックオフセットは常に上り方向で単調増加する。
const SEG_1_LENGTH = 3200;
const SEG_2_LENGTH = 2400;

const SEG_1: TrackSegment = {
  id: 'seg-1',
  lineId: 'line-1',
  fromStationId: 'st-1',
  toStationId: 'st-2',
  coordinates: [
    [35.4526, 139.3900],
    [35.4806, 139.4005],
  ],
  lengthMeters: SEG_1_LENGTH,
  startOffsetMeters: 0,
};

const SEG_2: TrackSegment = {
  id: 'seg-2',
  lineId: 'line-1',
  fromStationId: 'st-2',
  toStationId: 'st-3',
  coordinates: [
    [35.4806, 139.4005],
    [35.4988, 139.4144],
  ],
  lengthMeters: SEG_2_LENGTH,
  startOffsetMeters: SEG_1_LENGTH,
};

function buildNavState(
  direction: 'UP' | 'DOWN',
  trackPositionMeters: number,
  segmentId: string
): TrackNavigationState {
  return {
    lineId: 'line-1',
    routeId: null,
    segmentId,
    direction,
    trackPositionMeters,
    velocityMps: 25,
    accelerationMps2: 0,
    accelerationBiasMps2: 0,
    lastObservationTimestampMs: 10000,
    lastPredictionTimestampMs: 10000,
    mode: 'gps-locked',
    confidence: 0.9,
  };
}

const DUMMY_SPEED_STATE = {
  smoothedSpeedKmh: 90,
  isStopped: false,
  isValid: true,
} as unknown as FullSpeedState;

/**
 * GPSサンプル/RouteMatchを与えず、navStateの方向とセグメントだけで状態を評価する。
 * 進行方向がheading推定で上書きされないため、方向別の距離計算だけを検証できる。
 */
async function estimateAt(
  estimator: JourneyStateEstimator,
  direction: 'UP' | 'DOWN',
  trackPositionMeters: number,
  segment: TrackSegment
) {
  const navState = buildNavState(direction, trackPositionMeters, segment.id);
  return estimator.update(null, null, DUMMY_SPEED_STATE, navState, segment);
}

describe('JourneyStateEstimator - direction aware distance and progress', () => {
  const cases = [
    // 上りはセグメント終点(座間)へ向かうので、オフセットが進むほど残距離が減る。
    { direction: 'UP' as const, label: 'segment start', trackPosition: 0, distance: 3200, progress: 0, next: '座間' },
    { direction: 'UP' as const, label: 'segment middle', trackPosition: 1600, distance: 1600, progress: 0.5, next: '座間' },
    { direction: 'UP' as const, label: 'segment end', trackPosition: 3200, distance: 0, progress: 1, next: '座間' },
    // 下りはセグメント始点(海老名)へ向かうので、オフセットが進むほど残距離が増える。
    { direction: 'DOWN' as const, label: 'segment start', trackPosition: 0, distance: 0, progress: 1, next: '海老名' },
    { direction: 'DOWN' as const, label: 'segment middle', trackPosition: 1600, distance: 1600, progress: 0.5, next: '海老名' },
    { direction: 'DOWN' as const, label: 'segment end', trackPosition: 3200, distance: 3200, progress: 0, next: '海老名' },
  ];

  for (const testCase of cases) {
    it(`computes exact distance and progress for ${testCase.direction} at ${testCase.label}`, async () => {
      const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);

      const state = await estimateAt(estimator, testCase.direction, testCase.trackPosition, SEG_1);

      expect(state.direction).toBe(testCase.direction);
      expect(state.nextStation?.name).toBe(testCase.next);
      expect(state.distanceToNextStationMeters).toBe(testCase.distance);
      expect(state.progressRatio).toBe(testCase.progress);
    });
  }

  it('produces mirrored distance and progress for UP and DOWN at the same track position', async () => {
    const upEstimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);
    const downEstimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);

    const up = await estimateAt(upEstimator, 'UP', 1500, SEG_1);
    const down = await estimateAt(downEstimator, 'DOWN', 1500, SEG_1);

    expect(up.previousStation?.name).toBe('海老名');
    expect(up.nextStation?.name).toBe('座間');
    expect(up.distanceToNextStationMeters).toBe(1700);
    expect(up.progressRatio).toBe(0.46875);
    expect(up.directionName).toBe('上り');

    expect(down.previousStation?.name).toBe('座間');
    expect(down.nextStation?.name).toBe('海老名');
    expect(down.distanceToNextStationMeters).toBe(1500);
    expect(down.progressRatio).toBe(0.53125);
    expect(down.directionName).toBe('下り');

    // 残距離の合計はセグメント長、進捗率の合計は1になる(方向が逆転していない証拠)。
    expect(up.distanceToNextStationMeters! + down.distanceToNextStationMeters!).toBe(SEG_1_LENGTH);
    expect(up.progressRatio! + down.progressRatio!).toBe(1);
  });

  it('clamps distance and progress into segment bounds when the track position is outside the segment', async () => {
    const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);

    const upOvershoot = await estimateAt(estimator, 'UP', 5000, SEG_1);
    expect(upOvershoot.distanceToNextStationMeters).toBe(0);
    expect(upOvershoot.progressRatio).toBe(1);

    const upUndershoot = await estimateAt(estimator, 'UP', -500, SEG_1);
    expect(upUndershoot.distanceToNextStationMeters).toBe(SEG_1_LENGTH);
    expect(upUndershoot.progressRatio).toBe(0);

    const downOvershoot = await estimateAt(estimator, 'DOWN', 5000, SEG_1);
    expect(downOvershoot.distanceToNextStationMeters).toBe(SEG_1_LENGTH);
    expect(downOvershoot.progressRatio).toBe(0);

    const downUndershoot = await estimateAt(estimator, 'DOWN', -500, SEG_1);
    expect(downUndershoot.distanceToNextStationMeters).toBe(0);
    expect(downUndershoot.progressRatio).toBe(1);
  });

  it('keeps UP distance continuous across a segment boundary', async () => {
    const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);

    const beforeBoundary = await estimateAt(estimator, 'UP', 3000, SEG_1);
    expect(beforeBoundary.nextStation?.name).toBe('座間');
    expect(beforeBoundary.distanceToNextStationMeters).toBe(200);
    expect(beforeBoundary.progressRatio).toBe(0.9375);

    const atBoundary = await estimateAt(estimator, 'UP', 3200, SEG_1);
    expect(atBoundary.distanceToNextStationMeters).toBe(0);
    expect(atBoundary.progressRatio).toBe(1);

    // セグメント遷移直後は次駅が相武台前へ切り替わり、残距離はセグメント長から連続して減っていく。
    const afterBoundary = await estimateAt(estimator, 'UP', 3200, SEG_2);
    expect(afterBoundary.previousStation?.name).toBe('座間');
    expect(afterBoundary.nextStation?.name).toBe('相武台前');
    expect(afterBoundary.distanceToNextStationMeters).toBe(SEG_2_LENGTH);
    expect(afterBoundary.progressRatio).toBe(0);

    const advanced = await estimateAt(estimator, 'UP', 3800, SEG_2);
    expect(advanced.distanceToNextStationMeters).toBe(1800);
    expect(advanced.progressRatio).toBe(0.25);

    const advancedFurther = await estimateAt(estimator, 'UP', 4400, SEG_2);
    expect(advancedFurther.distanceToNextStationMeters).toBe(1200);
    expect(advancedFurther.progressRatio).toBe(0.5);
  });

  it('keeps DOWN distance continuous across a segment boundary', async () => {
    const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);

    const beforeBoundary = await estimateAt(estimator, 'DOWN', 4400, SEG_2);
    expect(beforeBoundary.previousStation?.name).toBe('相武台前');
    expect(beforeBoundary.nextStation?.name).toBe('座間');
    expect(beforeBoundary.distanceToNextStationMeters).toBe(1200);
    expect(beforeBoundary.progressRatio).toBe(0.5);

    const nearBoundary = await estimateAt(estimator, 'DOWN', 3800, SEG_2);
    expect(nearBoundary.distanceToNextStationMeters).toBe(600);
    expect(nearBoundary.progressRatio).toBe(0.75);

    const atBoundary = await estimateAt(estimator, 'DOWN', 3200, SEG_2);
    expect(atBoundary.distanceToNextStationMeters).toBe(0);
    expect(atBoundary.progressRatio).toBe(1);

    // セグメント遷移直後は次駅が海老名へ切り替わり、残距離はセグメント長から連続して減っていく。
    const afterBoundary = await estimateAt(estimator, 'DOWN', 3200, SEG_1);
    expect(afterBoundary.previousStation?.name).toBe('座間');
    expect(afterBoundary.nextStation?.name).toBe('海老名');
    expect(afterBoundary.distanceToNextStationMeters).toBe(SEG_1_LENGTH);
    expect(afterBoundary.progressRatio).toBe(0);

    const advanced = await estimateAt(estimator, 'DOWN', 1600, SEG_1);
    expect(advanced.distanceToNextStationMeters).toBe(1600);
    expect(advanced.progressRatio).toBe(0.5);
  });
});

describe('JourneyStateEstimator - unusable segment length', () => {
  // 前駅・次駅は特定できるがセグメント長が壊れているケース。
  // 「残り0m / 進捗100%」= 到着済み、と誤って断定してはいけない。
  it('reports unknown distance and progress instead of a bogus arrived state', async () => {
    const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);
    const brokenSegment: TrackSegment = { ...SEG_1, lengthMeters: 0 };

    const state = await estimateAt(estimator, 'UP', 1500, brokenSegment);

    expect(state.previousStation?.name).toBe('海老名');
    expect(state.nextStation?.name).toBe('座間');
    expect(state.distanceToNextStationMeters).toBeNull();
    expect(state.progressRatio).toBeNull();
  });

  it('reports unknown distance and progress for DOWN as well', async () => {
    const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);
    const brokenSegment: TrackSegment = { ...SEG_1, lengthMeters: Number.NaN };

    const state = await estimateAt(estimator, 'DOWN', 1500, brokenSegment);

    expect(state.previousStation?.name).toBe('座間');
    expect(state.nextStation?.name).toBe('海老名');
    expect(state.distanceToNextStationMeters).toBeNull();
    expect(state.progressRatio).toBeNull();
  });

  // セグメント長が壊れていて、かつセグメントの駅IDが路線の駅一覧に見つからない場合は
  // 駅フォールバックが距離を埋める。このとき progressRatio がセグメント側の値で
  // 埋まっていると haversine フォールバックが動かず、距離500mなのに進捗100%という
  // 矛盾した状態になる。progressRatio は null のまま残す必要がある。
  it('keeps the haversine fallback reachable when the segment length is unusable', async () => {
    const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);
    const brokenSegment: TrackSegment = {
      ...SEG_1,
      fromStationId: 'st-not-in-line',
      toStationId: 'st-also-not-in-line',
      lengthMeters: 0,
    };

    const state = await estimateAt(estimator, 'UP', 1500, brokenSegment);

    expect(state.previousStation?.name).toBe('海老名');
    expect(state.nextStation?.name).toBe('座間');
    // 駅フォールバックが埋めた残距離 (次駅オフセット 2000m - 現在位置 1500m)。
    expect(state.distanceToNextStationMeters).toBe(500);

    // 進捗率は駅間の直線距離ベースで再計算される(「到着済み」の1.0ではない)。
    const straightLineMeters = haversineDistance(35.4526, 139.3900, 35.4806, 139.4005);
    const expectedRatio = (straightLineMeters - 500) / straightLineMeters;
    expect(state.progressRatio).toBeCloseTo(expectedRatio, 10);
    expect(state.progressRatio).toBeLessThan(1);
  });
});

describe('computeSegmentProgress', () => {
  it('returns direction specific remaining distance within the segment', () => {
    expect(computeSegmentProgress(1500, 0, 3200, false)).toEqual({
      distanceToNextStationMeters: 1700,
      progressRatio: 0.46875,
    });
    expect(computeSegmentProgress(1500, 0, 3200, true)).toEqual({
      distanceToNextStationMeters: 1500,
      progressRatio: 0.53125,
    });
  });

  it('honours a non-zero segment start offset', () => {
    expect(computeSegmentProgress(4400, 3200, 2400, false)).toEqual({
      distanceToNextStationMeters: 1200,
      progressRatio: 0.5,
    });
    expect(computeSegmentProgress(4400, 3200, 2400, true)).toEqual({
      distanceToNextStationMeters: 1200,
      progressRatio: 0.5,
    });
  });

  it('rounds the distance while keeping the progress ratio unrounded', () => {
    expect(computeSegmentProgress(1024.5, 0, 4096, false)).toEqual({
      distanceToNextStationMeters: 3072,
      progressRatio: 0.2501220703125,
    });
  });

  // セグメント長が壊れているだけなのに 0m / 進捗1.0 を返すと「到着済み」と誤表示され、
  // さらに progressRatio が非nullになることで呼び出し側のフォールバックも塞いでしまう。
  it('returns null instead of a bogus arrived state when the segment length is not usable', () => {
    expect(computeSegmentProgress(100, 0, 0, false)).toBeNull();
    expect(computeSegmentProgress(100, 0, 0, true)).toBeNull();
    expect(computeSegmentProgress(100, 0, Number.NaN, true)).toBeNull();
    expect(computeSegmentProgress(100, 0, -1200, false)).toBeNull();
    expect(computeSegmentProgress(100, 0, Number.POSITIVE_INFINITY, false)).toBeNull();
  });
});

describe('direction normalization', () => {
  it('treats DOWN and its DIRECTION_B alias as the down direction', () => {
    expect(isDownDirection('DOWN')).toBe(true);
    expect(isDownDirection('DIRECTION_B')).toBe(true);
    expect(isDownDirection('UP')).toBe(false);
    expect(isDownDirection('DIRECTION_A')).toBe(false);
    expect(isDownDirection('UNKNOWN')).toBe(false);
  });

  it('treats UP and its DIRECTION_A alias as the up direction', () => {
    expect(isUpDirection('UP')).toBe(true);
    expect(isUpDirection('DIRECTION_A')).toBe(true);
    expect(isUpDirection('DOWN')).toBe(false);
    expect(isUpDirection('DIRECTION_B')).toBe(false);
    expect(isUpDirection('UNKNOWN')).toBe(false);
  });
});
