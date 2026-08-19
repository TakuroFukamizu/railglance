import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample, FullSpeedState, TrackNavigationState } from '../models/location';
import { JourneyState, RailwayLine, RouteMatch, Station, TrackSegment, TravelDirection, shouldDisplaySelectedRoute } from '../models/railway';
import { calculateBearing, calculateHeadingDifference } from '../geo/heading';
import { haversineDistance } from '../geo/distance';
import { RailwayDataRepository } from './repository';

const DEFAULT_SEGMENT_LENGTH_METERS = 2000;

type SegmentProgress = {
  distanceToNextStationMeters: number;
  progressRatio: number;
};

/**
 * DOWN側の別名(DIRECTION_B)も含めて「下り方向かどうか」を判定する。
 * 駅の割り当て・距離計算・方向名がすべて同じ判定を使うようにするためのヘルパー。
 */
export function isDownDirection(direction: TravelDirection): boolean {
  return direction === 'DOWN' || direction === 'DIRECTION_B';
}

/**
 * UP側の別名(DIRECTION_A)も含めて「上り方向かどうか」を判定する。
 */
export function isUpDirection(direction: TravelDirection): boolean {
  return direction === 'UP' || direction === 'DIRECTION_A';
}

/**
 * 現在セグメント内の走行位置から、次駅までの距離と進捗率を方向別に算出する。
 *
 * - UP  : セグメント終点(toStation)へ向かうため 残距離 = segmentEnd - trackPosition
 * - DOWN: セグメント始点(fromStation)へ向かうため 残距離 = trackPosition - segmentStart
 *
 * trackPosition がセグメント外(手前 / 行き過ぎ)にある場合でも、
 * 距離は [0, segmentLength]、進捗率は [0, 1] にclampする。
 * 距離と進捗率は同じセグメント長を基準に導出するため、常に整合する。
 *
 * セグメント長が有限の正数でない場合は「算出不能」を意味する null を返す。
 * ここで 0m / 進捗1.0 を返してしまうと、入力が壊れているだけなのにHUD上は
 * 「次駅に到着済み」と表示され、さらに progressRatio が非nullになることで
 * 呼び出し側のhaversineフォールバックまで塞いでしまうため。
 * フォールバックの選択は呼び出し側に委ねる。
 */
export function computeSegmentProgress(
  trackPositionMeters: number,
  startOffsetMeters: number,
  segmentLengthMeters: number,
  isDown: boolean
): SegmentProgress | null {
  if (!Number.isFinite(segmentLengthMeters) || segmentLengthMeters <= 0) {
    return null;
  }

  const offsetWithinSegment = Math.min(
    segmentLengthMeters,
    Math.max(0, trackPositionMeters - startOffsetMeters)
  );
  const remainingMeters = isDown ? offsetWithinSegment : segmentLengthMeters - offsetWithinSegment;
  const traveledMeters = segmentLengthMeters - remainingMeters;

  return {
    distanceToNextStationMeters: Math.round(remainingMeters),
    progressRatio: Math.min(1, Math.max(0, traveledMeters / segmentLengthMeters)),
  };
}

export class JourneyStateEstimator {
  private lastSample: LocationSample | null = null;
  private lastConfirmedDirection: TravelDirection = 'UNKNOWN';
  private cachedLine: RailwayLine | null = null;
  private lastMatchTimestampMs: number | null = null;

  constructor(
    private repository: RailwayDataRepository,
    private config: TrackingConfig
  ) {}

  public async update(
    sample: LocationSample | null,
    match: RouteMatch | null,
    speedState: FullSpeedState,
    navStateInput?: TrackNavigationState,
    currentSegmentInput?: TrackSegment | null
  ): Promise<JourneyState> {
    const navState = navStateInput ?? speedState?.navState;
    const now = sample?.timestampMs ?? navState?.lastPredictionTimestampMs ?? Date.now();

    const displayableMatch = shouldDisplaySelectedRoute(match) ? match : null;

    if (displayableMatch?.selectedLine) {
      this.cachedLine = displayableMatch.selectedLine;
      this.lastMatchTimestampMs = now;
    }

    const isDrActive = navState?.mode === 'dead-reckoning' || navState?.mode === 'dead-reckoning-low-confidence';
    if (isDrActive || navState?.mode === 'gps-locked' || navState?.mode === 'reacquiring') {
      if (this.lastMatchTimestampMs === null) {
        this.lastMatchTimestampMs = now;
      }
    }

    const isGraceExpired =
      !isDrActive &&
      this.lastMatchTimestampMs !== null &&
      now - this.lastMatchTimestampMs >= this.config.routeMatchLossGraceMs;

    if (!displayableMatch && !isDrActive && (navState?.mode === 'lost' || isGraceExpired)) {
      this.cachedLine = null;
      return {
        line: null,
        direction: 'UNKNOWN',
        directionName: null,
        previousStation: null,
        nextStation: null,
        distanceToNextStationMeters: null,
        progressRatio: null,
        stationDataComplete: true,
        confidence: 0.0,
        status: match?.lockState === 'UNRESOLVED' || match?.lockState === 'REACQUIRING' ? 'MATCHING_ROUTE' : 'ROUTE_UNCERTAIN',
        lockState: match?.lockState,
        manualLockAway: match?.manualLockAway,
      };
    }

    const activeLineId = displayableMatch?.selectedLine.id || navState?.lineId || this.cachedLine?.id;

    if (!activeLineId) {
      return {
        line: null,
        direction: 'UNKNOWN',
        directionName: null,
        previousStation: null,
        nextStation: null,
        distanceToNextStationMeters: null,
        progressRatio: null,
        stationDataComplete: true,
        confidence: 0.0,
        status: sample && sample.accuracyMeters > this.config.maxGpsAccuracyMeters
          ? 'GPS_LOW_ACCURACY'
          : match?.lockState === 'UNRESOLVED' || match?.lockState === 'REACQUIRING'
            ? 'MATCHING_ROUTE'
            : 'ROUTE_UNCERTAIN',
        lockState: match?.lockState,
        manualLockAway: match?.manualLockAway,
      };
    }

    const selectedLine = displayableMatch?.selectedLine || this.cachedLine || (await this.repository.getLine(activeLineId));
    if (selectedLine) {
      this.cachedLine = selectedLine;
    }

    if (!selectedLine) {
      return {
        line: null,
        direction: 'UNKNOWN',
        directionName: null,
        previousStation: null,
        nextStation: null,
        distanceToNextStationMeters: null,
        progressRatio: null,
        stationDataComplete: true,
        confidence: 0.0,
        status: 'ROUTE_UNCERTAIN',
        lockState: match?.lockState,
        manualLockAway: match?.manualLockAway,
      };
    }

    let direction: TravelDirection = 'UNKNOWN';
    if (displayableMatch && sample) {
      const heading = sample.headingDegrees ?? (this.lastSample
        ? calculateBearing(
            this.lastSample.latitude,
            this.lastSample.longitude,
            sample.latitude,
            sample.longitude
          )
        : null);

      if (heading !== null) {
        const coords = displayableMatch.selectedSegment.coordinates;
        const startPoint = coords[0];
        const endPoint = coords[coords.length - 1];
        const segmentBearing = calculateBearing(startPoint[0], startPoint[1], endPoint[0], endPoint[1]);
        const diff = calculateHeadingDifference(heading, segmentBearing);

        direction = diff < 90 ? 'UP' : 'DOWN';
      }
    }

    if (direction !== 'UNKNOWN') {
      this.lastConfirmedDirection = direction;
    } else if (navState && navState.direction !== 'UNKNOWN') {
      direction = navState.direction;
      this.lastConfirmedDirection = direction;
    } else if (this.lastConfirmedDirection !== 'UNKNOWN') {
      direction = this.lastConfirmedDirection;
    } else {
      direction = 'UP';
    }

    if (sample) {
      this.lastSample = sample;
    }

    const lineStations = await this.repository.getStationsByLine(selectedLine.id);
    const stationDataComplete = (await this.repository.getStationDataCompleteness?.(selectedLine.id)) ?? true;
    if (lineStations.length === 0) {
      return {
        line: selectedLine,
        direction,
        directionName: null,
        previousStation: null,
        nextStation: null,
        distanceToNextStationMeters: null,
        progressRatio: null,
        stationDataComplete,
        confidence: displayableMatch ? displayableMatch.confidence : 0.5,
        status: 'ROUTE_UNCERTAIN',
        lockState: match?.lockState,
        manualLockAway: match?.manualLockAway,
      };
    }

    const orderedStations = [...lineStations].sort((a, b) => a.sequence - b.sequence);
    let previousStation: Station | null = null;
    let nextStation: Station | null = null;
    let distanceToNextStationMeters: number | null = null;
    let progressRatio: number | null = null;

    const currentSeg = currentSegmentInput || displayableMatch?.selectedSegment;
    const isDown = isDownDirection(direction);

    if (currentSeg && (currentSeg.fromStationId || currentSeg.toStationId)) {
      const fromSt = lineStations.find((st) => st.id === currentSeg.fromStationId) ?? null;
      const toSt = lineStations.find((st) => st.id === currentSeg.toStationId) ?? null;

      if (isDown) {
        previousStation = toSt || fromSt;
        nextStation = fromSt || toSt;
      } else {
        previousStation = fromSt || toSt;
        nextStation = toSt || fromSt;
      }

      if (navState && navState.trackPositionMeters !== null && currentSeg.startOffsetMeters !== undefined) {
        const segLength = currentSeg.lengthMeters ?? DEFAULT_SEGMENT_LENGTH_METERS;
        const progress = computeSegmentProgress(
          navState.trackPositionMeters,
          currentSeg.startOffsetMeters,
          segLength,
          isDown
        );
        // セグメント長が使えない場合は両方ともnullのまま残し、「不明」として
        // 駅フォールバック / haversineフォールバック / UI側の判断に委ねる。
        // 片方だけ埋めると距離と進捗が矛盾するため、必ず両方まとめて代入する。
        if (progress) {
          distanceToNextStationMeters = progress.distanceToNextStationMeters;
          progressRatio = progress.progressRatio;
        }
      }
    }

    if (!previousStation || !nextStation) {
      // ここに来るのは前駅・次駅がまだ確定していない場合(セグメントが無い /
      // セグメントに駅IDが無い / 駅IDが路線の駅一覧に解決できない)。
      // いずれの場合も、これから報告する駅ペアは駅スキャンが決めるため、
      // セグメント由来の距離・進捗はその駅ペアについての値ではない。
      // 両方まとめて破棄し、距離は駅スキャンが、進捗率は後段のhaversine
      // フォールバックが同じ駅ペアから算出し直すようにする。
      // (セグメント側が最初から何も入れていない場合、この破棄は無害なno-op)
      distanceToNextStationMeters = null;
      progressRatio = null;

      let refLat: number | null = null;
      let refLon: number | null = null;
      let refTrackOffset: number | null = null;

      if (navState && navState.trackPositionMeters !== null) {
        refTrackOffset = navState.trackPositionMeters;
      } else if (sample) {
        refLat = sample.latitude;
        refLon = sample.longitude;
      }

      if (!isDown) {
        for (let i = 0; i < orderedStations.length; i++) {
          const st = orderedStations[i];
          let stDistFromRef: number | null = null;

          if (refLat !== null && refLon !== null) {
            stDistFromRef = haversineDistance(refLat, refLon, st.latitude, st.longitude);
          }

          if (refTrackOffset !== null) {
            const stOffset = (st.sequence - 1) * DEFAULT_SEGMENT_LENGTH_METERS;
            if (stOffset <= refTrackOffset) {
              previousStation = st;
            } else if (!nextStation) {
              nextStation = st;
              distanceToNextStationMeters = Math.max(0, Math.round(stOffset - refTrackOffset));
              break;
            }
          } else if (refLat !== null && refLon !== null) {
            if (!nextStation) {
              nextStation = st;
              previousStation = i > 0 ? orderedStations[i - 1] : st;
              distanceToNextStationMeters = Math.round(stDistFromRef!);
              break;
            }
          }
        }
      } else {
        const reversed = [...orderedStations].reverse();
        for (let i = 0; i < reversed.length; i++) {
          const st = reversed[i];
          if (refTrackOffset !== null) {
            const stOffset = (st.sequence - 1) * DEFAULT_SEGMENT_LENGTH_METERS;
            if (stOffset >= refTrackOffset) {
              previousStation = st;
            } else if (!nextStation) {
              nextStation = st;
              distanceToNextStationMeters = Math.max(0, Math.round(refTrackOffset - stOffset));
              break;
            }
          } else if (refLat !== null && refLon !== null) {
            if (!nextStation) {
              nextStation = st;
              previousStation = i > 0 ? reversed[i - 1] : st;
              distanceToNextStationMeters = Math.round(haversineDistance(refLat, refLon, st.latitude, st.longitude));
              break;
            }
          }
        }
      }
    }

    if (!stationDataComplete) {
      // Bundled/sparse fallback data: do not assert a specific next station,
      // since intermediate real stations may be missing from this dataset.
      // Line, direction, and confidence are unaffected — only the specific
      // station identity/distance/progress claims are suppressed.
      previousStation = null;
      nextStation = null;
      distanceToNextStationMeters = null;
      progressRatio = null;
    }

    // セグメント長ベースで進捗率を確定できなかった場合のみ、駅間の直線距離で近似する。
    if (progressRatio === null && previousStation && nextStation && distanceToNextStationMeters !== null) {
      const totalSegDist = haversineDistance(
        previousStation.latitude,
        previousStation.longitude,
        nextStation.latitude,
        nextStation.longitude
      );
      if (totalSegDist > 0) {
        const traveled = Math.max(0, totalSegDist - distanceToNextStationMeters);
        progressRatio = Math.min(1.0, Math.max(0.0, traveled / totalSegDist));
      }
    }

    // 方向が確定していない場合は方向名を出さない(現状の制御フローでは到達しないが、
    // 誤った方向名をHUDに出さないためのガードとして残す)。
    const directionName = isDown
      ? selectedLine.directionBName ?? '下り'
      : isUpDirection(direction)
        ? selectedLine.directionAName ?? '上り'
        : null;
    const confidence = displayableMatch ? displayableMatch.confidence : (navState?.confidence ?? 0.5);

    let status: JourneyState['status'] = 'TRACKING';
    if (match?.lockState === 'UNRESOLVED' || match?.lockState === 'REACQUIRING') {
      status = 'MATCHING_ROUTE';
    } else if (match?.lockState === 'SUSPICIOUS') {
      status = 'ROUTE_UNCERTAIN';
    } else if (navState?.mode === 'dead-reckoning' || navState?.mode === 'dead-reckoning-low-confidence') {
      status = 'TRACKING';
    } else if (confidence < this.config.confidenceMedium) {
      status = 'ROUTE_UNCERTAIN';
    }

    return {
      line: selectedLine,
      direction,
      directionName,
      previousStation,
      nextStation,
      distanceToNextStationMeters,
      progressRatio,
      stationDataComplete,
      confidence,
      status,
      lockState: match?.lockState,
      manualLockAway: match?.manualLockAway,
    };
  }

  public reset(): void {
    this.lastSample = null;
    this.lastConfirmedDirection = 'UNKNOWN';
    this.cachedLine = null;
    this.lastMatchTimestampMs = null;
  }

  public invalidateRoute(): void {
    this.lastConfirmedDirection = 'UNKNOWN';
    this.cachedLine = null;
    this.lastMatchTimestampMs = null;
  }
}
