import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample, FullSpeedState, TrackNavigationState } from '../models/location';
import { JourneyState, RailwayLine, RouteMatch, Station, TrackSegment, TravelDirection } from '../models/railway';
import { calculateBearing, calculateHeadingDifference } from '../geo/heading';
import { haversineDistance } from '../geo/distance';
import { RailwayDataRepository } from './repository';

export class JourneyStateEstimator {
  private lastSample: LocationSample | null = null;
  private lastConfirmedDirection: TravelDirection = 'UNKNOWN';
  private cachedLine: RailwayLine | null = null;

  constructor(
    private repository: RailwayDataRepository,
    private config: TrackingConfig
  ) {}

  public async update(
    sample: LocationSample | null,
    match: RouteMatch | null,
    speedState: FullSpeedState,
    navState?: TrackNavigationState,
    currentSegment?: TrackSegment | null
  ): Promise<JourneyState> {
    if (match?.selectedLine) {
      this.cachedLine = match.selectedLine;
    }

    const activeLineId = match?.selectedLine.id || navState?.lineId || (!navState ? this.cachedLine?.id : undefined);

    if (!activeLineId) {
      return {
        line: null,
        direction: 'UNKNOWN',
        directionName: null,
        previousStation: null,
        nextStation: null,
        distanceToNextStationMeters: null,
        progressRatio: null,
        confidence: 0.0,
        status: sample && sample.accuracyMeters > this.config.maxGpsAccuracyMeters ? 'GPS_LOW_ACCURACY' : 'ROUTE_UNCERTAIN',
      };
    }

    const selectedLine = match?.selectedLine || this.cachedLine || (await this.repository.getLine(activeLineId));
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
        confidence: 0.0,
        status: 'ROUTE_UNCERTAIN',
      };
    }

    const isDeadReckoning = navState?.mode === 'dead-reckoning' || navState?.mode === 'dead-reckoning-low-confidence';
    const activeSegment = isDeadReckoning
      ? currentSegment || match?.selectedSegment || null
      : match?.selectedSegment || currentSegment || null;
    const stations = await this.repository.getStationsByLine(selectedLine.id);
    stations.sort((a, b) => a.sequence - b.sequence);

    const fromStation = activeSegment ? stations.find((s) => s.id === activeSegment.fromStationId) ?? null : null;
    const toStation = activeSegment ? stations.find((s) => s.id === activeSegment.toStationId) ?? null : null;

    // 1. Determine direction (Direction A / Up vs Direction B / Down)
    let direction: TravelDirection = this.lastConfirmedDirection;

    if (activeSegment && sample) {
      let trackBearing = 0;
      if (activeSegment.coordinates.length >= 2) {
        const p1 = activeSegment.coordinates[0];
        const p2 = activeSegment.coordinates[activeSegment.coordinates.length - 1];
        trackBearing = calculateBearing(p1[0], p1[1], p2[0], p2[1]);
      }

      let currentHeading: number | null = sample.headingDegrees;
      if (currentHeading === null && this.lastSample) {
        const movedDist = haversineDistance(
          this.lastSample.latitude,
          this.lastSample.longitude,
          sample.latitude,
          sample.longitude
        );
        if (movedDist >= 5) {
          currentHeading = calculateBearing(
            this.lastSample.latitude,
            this.lastSample.longitude,
            sample.latitude,
            sample.longitude
          );
        }
      }

      const currentSpeedKmh = speedState.smoothedSpeedKmh;
      if (fromStation && toStation && currentHeading !== null && currentSpeedKmh !== null && currentSpeedKmh >= 3) {
        const diffForward = calculateHeadingDifference(currentHeading, trackBearing);
        const diffBackward = calculateHeadingDifference(currentHeading, (trackBearing + 180) % 360);
        const isIncreasingSeq = fromStation.sequence < toStation.sequence;

        if (diffForward < diffBackward && diffForward < 60) {
          direction = isIncreasingSeq ? 'UP' : 'DOWN';
        } else if (diffBackward < diffForward && diffBackward < 60) {
          direction = isIncreasingSeq ? 'DOWN' : 'UP';
        }
      }
    }

    this.lastConfirmedDirection = direction;

    if (sample) {
      this.lastSample = sample;
    }

    // 2. Determine previousStation, nextStation, distanceToNextStation, and real progressRatio
    let previousStation: Station | null = null;
    let nextStation: Station | null = null;
    let distanceToNextStationMeters: number | null = null;
    let progressRatio: number | null = null;

    if (fromStation && toStation) {
      const isFromToUp = fromStation.sequence < toStation.sequence;

      if (direction === 'UP') {
        previousStation = isFromToUp ? fromStation : toStation;
        nextStation = isFromToUp ? toStation : fromStation;
      } else if (direction === 'DOWN') {
        previousStation = isFromToUp ? toStation : fromStation;
        nextStation = isFromToUp ? fromStation : toStation;
      } else {
        previousStation = fromStation;
        nextStation = toStation;
      }

      const segLen = activeSegment?.lengthMeters ?? 2000;
      let posInSeg = 0;

      if (activeSegment && navState && navState.trackPositionMeters !== null && activeSegment.startOffsetMeters !== undefined) {
        posInSeg = Math.max(0, Math.min(segLen, navState.trackPositionMeters - activeSegment.startOffsetMeters));
      } else {
        posInSeg = segLen * 0.5;
      }

      if (nextStation === toStation) {
        distanceToNextStationMeters = Math.max(0, segLen - posInSeg);
        progressRatio = Math.max(0, Math.min(1.0, posInSeg / segLen));
      } else {
        distanceToNextStationMeters = Math.max(0, posInSeg);
        progressRatio = Math.max(0, Math.min(1.0, (segLen - posInSeg) / segLen));
      }

      distanceToNextStationMeters = Math.round(distanceToNextStationMeters);
    }

    let directionName: string | null = null;
    if (direction === 'UP') {
      directionName = selectedLine.directionAName || '上り';
    } else if (direction === 'DOWN') {
      directionName = selectedLine.directionBName || '下り';
    }

    const confidence = match ? match.confidence : (navState?.confidence ?? 0.5);

    let status: JourneyState['status'] = 'TRACKING';
    if (navState?.mode === 'dead-reckoning' || navState?.mode === 'dead-reckoning-low-confidence') {
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
      confidence,
      status,
    };
  }

  public reset(): void {
    this.lastSample = null;
    this.lastConfirmedDirection = 'UNKNOWN';
    this.cachedLine = null;
  }

  public invalidateRoute(): void {
    this.lastConfirmedDirection = 'UNKNOWN';
    this.cachedLine = null;
  }
}
