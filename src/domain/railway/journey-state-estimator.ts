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

    if (match?.selectedLine) {
      this.cachedLine = match.selectedLine;
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

    if (!match && !isDrActive && (navState?.mode === 'lost' || isGraceExpired)) {
      this.cachedLine = null;
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

    const activeLineId = match?.selectedLine.id || navState?.lineId || this.cachedLine?.id;

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

    let direction: TravelDirection = 'UNKNOWN';
    if (navState && navState.direction !== 'UNKNOWN') {
      direction = navState.direction;
      this.lastConfirmedDirection = direction;
    } else if (match && sample && this.lastSample) {
      const heading = sample.headingDegrees ?? calculateBearing(
        this.lastSample.latitude,
        this.lastSample.longitude,
        sample.latitude,
        sample.longitude
      );

      const coords = match.selectedSegment.coordinates;
      const startPoint = coords[0];
      const endPoint = coords[coords.length - 1];
      const segmentBearing = calculateBearing(startPoint[0], startPoint[1], endPoint[0], endPoint[1]);
      const diff = calculateHeadingDifference(heading, segmentBearing);

      direction = diff < 90 ? 'UP' : 'DOWN';
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
    if (lineStations.length === 0) {
      return {
        line: selectedLine,
        direction,
        directionName: null,
        previousStation: null,
        nextStation: null,
        distanceToNextStationMeters: null,
        progressRatio: null,
        confidence: match ? match.confidence : 0.5,
        status: 'ROUTE_UNCERTAIN',
      };
    }

    const orderedStations = [...lineStations].sort((a, b) => a.sequence - b.sequence);
    let previousStation: Station | null = null;
    let nextStation: Station | null = null;
    let distanceToNextStationMeters: number | null = null;
    let progressRatio: number | null = null;

    const currentSeg = currentSegmentInput || match?.selectedSegment;

    if (currentSeg && (currentSeg.fromStationId || currentSeg.toStationId)) {
      const fromSt = lineStations.find((st) => st.id === currentSeg.fromStationId) ?? null;
      const toSt = lineStations.find((st) => st.id === currentSeg.toStationId) ?? null;

      if (direction === 'DOWN') {
        previousStation = toSt || fromSt;
        nextStation = fromSt || toSt;
      } else {
        previousStation = fromSt || toSt;
        nextStation = toSt || fromSt;
      }

      if (navState && navState.trackPositionMeters !== null && currentSeg.startOffsetMeters !== undefined) {
        const segLength = currentSeg.lengthMeters ?? 2000;
        const endOffset = currentSeg.startOffsetMeters + segLength;
        distanceToNextStationMeters = Math.max(0, Math.round(endOffset - navState.trackPositionMeters));
      }
    }

    if (!previousStation || !nextStation) {
      let refLat: number | null = null;
      let refLon: number | null = null;
      let refTrackOffset: number | null = null;

      if (navState && navState.trackPositionMeters !== null) {
        refTrackOffset = navState.trackPositionMeters;
      } else if (sample) {
        refLat = sample.latitude;
        refLon = sample.longitude;
      }

      if (direction === 'UP') {
        for (let i = 0; i < orderedStations.length; i++) {
          const st = orderedStations[i];
          let stDistFromRef: number | null = null;

          if (refLat !== null && refLon !== null) {
            stDistFromRef = haversineDistance(refLat, refLon, st.latitude, st.longitude);
          }

          if (refTrackOffset !== null) {
            const stOffset = (st.sequence - 1) * 2000;
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
      } else if (direction === 'DOWN') {
        const reversed = [...orderedStations].reverse();
        for (let i = 0; i < reversed.length; i++) {
          const st = reversed[i];
          if (refTrackOffset !== null) {
            const stOffset = (st.sequence - 1) * 2000;
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

    if (previousStation && nextStation && distanceToNextStationMeters !== null) {
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

    const directionName = direction === 'UP' ? '上り' : direction === 'DOWN' ? '下り' : null;
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
    this.lastMatchTimestampMs = null;
  }

  public invalidateRoute(): void {
    this.lastConfirmedDirection = 'UNKNOWN';
    this.cachedLine = null;
    this.lastMatchTimestampMs = null;
  }
}
