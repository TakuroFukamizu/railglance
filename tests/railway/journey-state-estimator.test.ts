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

// セグメント長は正常だが、セグメントが指す駅IDが路線の駅一覧に存在しないケース。
// このとき報告される前駅・次駅は駅スキャンのフォールバックが決めるため、
// セグメント由来の progressRatio は「別の駅ペアについての進捗」であり、
// フォールバックが上書きした距離とは根拠が食い違う。
describe('JourneyStateEstimator - unresolvable segment stations', () => {
  const orphanSegment: TrackSegment = {
    ...SEG_1,
    fromStationId: 'st-not-in-line',
    toStationId: 'st-also-not-in-line',
  };

  it('recomputes progress from the stations it actually reports (UP)', async () => {
    const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);

    const state = await estimateAt(estimator, 'UP', 1500, orphanSegment);

    expect(state.previousStation?.name).toBe('海老名');
    expect(state.nextStation?.name).toBe('座間');
    // 駅フォールバックが埋めた残距離 (次駅オフセット 2000m - 現在位置 1500m)。
    expect(state.distanceToNextStationMeters).toBe(500);

    // 進捗率は報告した駅ペアの直線距離から再計算されなければならない。
    // セグメント長由来の 1500/3200 = 0.469 が残っていると距離と矛盾する。
    const straightLineMeters = haversineDistance(35.4526, 139.3900, 35.4806, 139.4005);
    const expectedRatio = (straightLineMeters - 500) / straightLineMeters;
    expect(state.progressRatio).toBeCloseTo(expectedRatio, 10);
  });

  it('recomputes progress from the stations it actually reports (DOWN)', async () => {
    const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);

    const state = await estimateAt(estimator, 'DOWN', 1500, orphanSegment);

    expect(state.previousStation?.name).toBe('座間');
    expect(state.nextStation?.name).toBe('海老名');
    // 下りの駅フォールバックは現在位置から前方(オフセット減少側)の駅までを測る。
    expect(state.distanceToNextStationMeters).toBe(1500);

    const straightLineMeters = haversineDistance(35.4806, 139.4005, 35.4526, 139.3900);
    const expectedRatio = (straightLineMeters - 1500) / straightLineMeters;
    expect(state.progressRatio).toBeCloseTo(expectedRatio, 10);
  });

  it('keeps distance and progress derived from the same station pair', async () => {
    const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);

    const state = await estimateAt(estimator, 'UP', 1500, orphanSegment);

    // 距離と進捗が同じ根拠なら、進捗から距離を復元できる。
    // 不変条件を測る前に、測る対象が揃っていることを明示的に確認する。
    // 欠けている場合はここで落として原因を示す(後段の非nullアサーションで
    // 分かりにくい実行時エラーにしない)。
    expect(state.previousStation).not.toBeNull();
    expect(state.nextStation).not.toBeNull();
    expect(state.progressRatio).not.toBeNull();
    expect(state.distanceToNextStationMeters).not.toBeNull();

    const straightLineMeters = haversineDistance(
      state.previousStation!.latitude,
      state.previousStation!.longitude,
      state.nextStation!.latitude,
      state.nextStation!.longitude
    );
    const impliedRemaining = straightLineMeters * (1 - state.progressRatio!);
    expect(impliedRemaining).toBeCloseTo(state.distanceToNextStationMeters!, 6);
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

describe('JourneyStateEstimator - station data completeness', () => {
  const ODAKYU: RailwayLine = {
    id: 'odakyu-odawara',
    operatorId: 'odakyu',
    name: '小田急小田原線',
    directionAName: '上り',
    directionBName: '下り',
  };

  const MACHIDA: Station = {
    id: 'st-machida',
    lineId: 'odakyu-odawara',
    name: '町田',
    sequence: 7,
    latitude: 35.5424,
    longitude: 139.4456,
  };

  const SHINYURIGAOKA: Station = {
    id: 'st-shinyurigaoka',
    lineId: 'odakyu-odawara',
    name: '新百合ヶ丘',
    sequence: 8,
    latitude: 35.6038,
    longitude: 139.5076,
  };

  // Mirrors bundled `seg-machida-shinyurigaoka`, which skips 玉川学園前 / 鶴川 / 柿生.
  const SPARSE_SEGMENT: TrackSegment = {
    id: 'seg-machida-shinyurigaoka',
    lineId: 'odakyu-odawara',
    fromStationId: 'st-machida',
    toStationId: 'st-shinyurigaoka',
    coordinates: [
      [35.5424, 139.4456],
      [35.5700, 139.4750],
      [35.6038, 139.5076],
    ],
    lengthMeters: 8800,
    startOffsetMeters: 0,
  };

  class CompletenessRepository implements RailwayDataRepository {
    getStationDataCompleteness?: (lineId: string) => Promise<boolean>;

    constructor(
      private stations: Station[],
      completeness?: boolean
    ) {
      if (completeness !== undefined) {
        this.getStationDataCompleteness = async () => completeness;
      }
    }

    async ensureCoverageAround(): Promise<RailwayCoverageResult> {
      return { state: 'bundled', loadedTileCount: 0 };
    }
    async findSegmentsNear(): Promise<TrackSegment[]> {
      return [];
    }
    async getLine(lineId: string): Promise<RailwayLine | undefined> {
      return { ...ODAKYU, id: lineId };
    }
    async getRoute(): Promise<RailwayRoute | undefined> {
      return undefined;
    }
    async getStation(id: string): Promise<Station | undefined> {
      return this.stations.find((station) => station.id === id);
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

  function sparseMatch(): RouteMatch {
    return {
      selectedLine: ODAKYU,
      selectedSegment: SPARSE_SEGMENT,
      confidence: 0.9,
      candidates: [],
      timestampMs: 10000,
    };
  }

  function sparseSample(): LocationSample {
    return {
      latitude: 35.56,
      longitude: 139.46,
      accuracyMeters: 10,
      speedMps: 25,
      headingDegrees: 45,
      timestampMs: 10000,
    };
  }

  function sparseSpeedState(): FullSpeedState {
    const selectedEst: SpeedEstimate = {
      speedKmh: 90,
      confidence: 0.9,
      source: 'os-geolocation',
      timestamp: 10000,
    };
    return {
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
        lineId: 'odakyu-odawara',
        routeId: null,
        segmentId: SPARSE_SEGMENT.id,
        direction: 'UP',
        trackPositionMeters: 2000,
        velocityMps: 25,
        accelerationMps2: 0,
        accelerationBiasMps2: 0,
        lastObservationTimestampMs: 10000,
        lastPredictionTimestampMs: 10000,
        mode: 'gps-locked',
        confidence: 0.9,
      },
    };
  }

  async function estimateSparse(
    repository: RailwayDataRepository
  ) {
    const estimator = new JourneyStateEstimator(repository, DEFAULT_TRACKING_CONFIG);
    const speedState = sparseSpeedState();
    return estimator.update(
      sparseSample(),
      sparseMatch(),
      speedState,
      speedState.navState,
      SPARSE_SEGMENT
    );
  }

  it('suppresses next station when station data is marked incomplete', async () => {
    const state = await estimateSparse(
      new CompletenessRepository([MACHIDA, SHINYURIGAOKA], false)
    );

    expect(state.stationDataComplete).toBe(false);
    expect(state.previousStation).toBeNull();
    expect(state.nextStation).toBeNull();
    expect(state.distanceToNextStationMeters).toBeNull();
    expect(state.progressRatio).toBeNull();

    expect(state.line?.id).toBe('odakyu-odawara');
    expect(state.direction).toBe('UP');
    expect(state.directionName).toBe('上り');
    expect(state.confidence).toBe(0.9);
    expect(state.status).toBe('TRACKING');
  });

  it('still resolves next station when station data is marked complete', async () => {
    const state = await estimateSparse(
      new CompletenessRepository([MACHIDA, SHINYURIGAOKA], true)
    );

    expect(state.stationDataComplete).toBe(true);
    expect(state.previousStation?.id).toBe('st-machida');
    expect(state.nextStation?.id).toBe('st-shinyurigaoka');
    expect(state.previousStation?.name).toBe('町田');
    expect(state.nextStation?.name).toBe('新百合ヶ丘');
    expect(state.distanceToNextStationMeters).toBe(6800);
    expect(state.progressRatio).toBe(2000 / 8800);
    expect(state.line?.id).toBe('odakyu-odawara');
    expect(state.direction).toBe('UP');
    expect(state.confidence).toBe(0.9);
  });

  it('defaults to complete when the repository does not implement completeness reporting', async () => {
    const estimator = new JourneyStateEstimator(new MockStationDatabase(), DEFAULT_TRACKING_CONFIG);

    const state = await estimateAt(estimator, 'UP', 1500, SEG_1);

    expect(state.stationDataComplete).toBe(true);
    expect(state.previousStation?.name).toBe('海老名');
    expect(state.nextStation?.name).toBe('座間');
    expect(state.distanceToNextStationMeters).toBe(1700);
    expect(state.progressRatio).toBe(1500 / 3200);
  });

  it('walks through intermediate stations in order on a complete dataset without skipping', async () => {
    const stations: Station[] = [
      { id: 'st-machida', lineId: 'odakyu-odawara', name: '町田', sequence: 1, latitude: 35.5424, longitude: 139.4456 },
      { id: 'st-tamagawagakuenmae', lineId: 'odakyu-odawara', name: '玉川学園前', sequence: 2, latitude: 35.5630, longitude: 139.4620 },
      { id: 'st-tsurukawa', lineId: 'odakyu-odawara', name: '鶴川', sequence: 3, latitude: 35.5830, longitude: 139.4810 },
      { id: 'st-kakio', lineId: 'odakyu-odawara', name: '柿生', sequence: 4, latitude: 35.5940, longitude: 139.4960 },
      { id: 'st-shinyurigaoka', lineId: 'odakyu-odawara', name: '新百合ヶ丘', sequence: 5, latitude: 35.6038, longitude: 139.5076 },
    ];

    const lengths = [2500, 2300, 1800, 2200];
    const pairs: Array<[string, string]> = [
      ['st-machida', 'st-tamagawagakuenmae'],
      ['st-tamagawagakuenmae', 'st-tsurukawa'],
      ['st-tsurukawa', 'st-kakio'],
      ['st-kakio', 'st-shinyurigaoka'],
    ];
    let offset = 0;
    const segments: TrackSegment[] = pairs.map(([fromStationId, toStationId], index) => {
      const from = stations[index];
      const to = stations[index + 1];
      const segment: TrackSegment = {
        id: `seg-${fromStationId}-${toStationId}`,
        lineId: 'odakyu-odawara',
        fromStationId,
        toStationId,
        coordinates: [
          [from.latitude, from.longitude],
          [to.latitude, to.longitude],
        ],
        lengthMeters: lengths[index],
        startOffsetMeters: offset,
      };
      offset += lengths[index];
      return segment;
    });

    const estimator = new JourneyStateEstimator(
      new CompletenessRepository(stations, true),
      DEFAULT_TRACKING_CONFIG
    );

    const expectedNext = ['玉川学園前', '鶴川', '柿生', '新百合ヶ丘'];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const midPosition = (segment.startOffsetMeters ?? 0) + lengths[i] / 2;
      const navState = {
        lineId: 'odakyu-odawara',
        routeId: null,
        segmentId: segment.id,
        direction: 'UP' as const,
        trackPositionMeters: midPosition,
        velocityMps: 25,
        accelerationMps2: 0,
        accelerationBiasMps2: 0,
        lastObservationTimestampMs: 10000 + i * 1000,
        lastPredictionTimestampMs: 10000 + i * 1000,
        mode: 'gps-locked' as const,
        confidence: 0.9,
      };

      const state = await estimator.update(null, null, DUMMY_SPEED_STATE, navState, segment);

      expect(state.stationDataComplete).toBe(true);
      expect(state.nextStation?.name).toBe(expectedNext[i]);
      expect(state.previousStation?.name).toBe(stations[i].name);
      if (i === 0) {
        expect(state.nextStation?.name).not.toBe('鶴川');
        expect(state.nextStation?.name).not.toBe('新百合ヶ丘');
      }
      if (i < segments.length - 1) {
        expect(state.nextStation?.name).not.toBe('新百合ヶ丘');
      }
    }
  });
});
