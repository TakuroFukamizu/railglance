import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample, FullSpeedState } from '../models/location';
import { JourneyState, RouteMatch, Station, TravelDirection } from '../models/railway';
import { calculateBearing, calculateHeadingDifference } from '../geo/heading';
import { findClosestPointOnPolyline } from '../geo/polyline';
import { haversineDistance } from '../geo/distance';

export interface StationDatabaseReader {
  getStationsByLine(lineId: string): Promise<Station[]>;
  getStation(stationId: string): Promise<Station | undefined>;
}

export class JourneyStateEstimator {
  private lastSample: LocationSample | null = null;
  private lastConfirmedDirection: TravelDirection = 'UNKNOWN';

  constructor(
    private stationDb: StationDatabaseReader,
    private config: TrackingConfig
  ) {}

  public async update(
    sample: LocationSample,
    match: RouteMatch | null,
    speedState: FullSpeedState
  ): Promise<JourneyState> {
    if (!match) {
      return {
        line: null,
        direction: 'UNKNOWN',
        directionName: null,
        previousStation: null,
        nextStation: null,
        distanceToNextStationMeters: null,
        confidence: 0.0,
        status: sample.accuracyMeters > this.config.maxGpsAccuracyMeters ? 'GPS_LOW_ACCURACY' : 'ROUTE_UNCERTAIN',
      };
    }

    const { selectedLine, selectedSegment, confidence } = match;
    const stations = await this.stationDb.getStationsByLine(selectedLine.id);
    stations.sort((a, b) => a.sequence - b.sequence);

    const fromStation = stations.find((s) => s.id === selectedSegment.fromStationId) ?? null;
    const toStation = stations.find((s) => s.id === selectedSegment.toStationId) ?? null;

    // 1. Determine direction (Direction A / Up vs Direction B / Down)
    let direction: TravelDirection = this.lastConfirmedDirection;

    let trackBearing = 0;
    if (selectedSegment.coordinates.length >= 2) {
      const p1 = selectedSegment.coordinates[0];
      const p2 = selectedSegment.coordinates[selectedSegment.coordinates.length - 1];
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
        // Heading matches p1 -> p2 (fromStation to toStation vector)
        direction = isIncreasingSeq ? 'UP' : 'DOWN';
      } else if (diffBackward < diffForward && diffBackward < 60) {
        // Heading matches p2 -> p1 (toStation to fromStation vector)
        direction = isIncreasingSeq ? 'DOWN' : 'UP';
      }
    }

    if (direction !== 'UNKNOWN') {
      this.lastConfirmedDirection = direction;
    }

    this.lastSample = sample;

    // 2. Determine previousStation, nextStation, and distanceToNextStation
    let previousStation: Station | null = null;
    let nextStation: Station | null = null;
    let distanceToNextStationMeters: number | null = null;

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

      const polylineRes = findClosestPointOnPolyline(sample.latitude, sample.longitude, selectedSegment.coordinates);
      if (nextStation === toStation) {
        distanceToNextStationMeters = Math.max(
          0,
          polylineRes.totalPolylineLengthMeters - polylineRes.distanceAlongPolylineMeters
        );
      } else {
        distanceToNextStationMeters = Math.max(0, polylineRes.distanceAlongPolylineMeters);
      }
      distanceToNextStationMeters = Math.round(distanceToNextStationMeters);
    }

    let directionName: string | null = null;
    if (direction === 'UP') {
      directionName = selectedLine.directionAName || '上り';
    } else if (direction === 'DOWN') {
      directionName = selectedLine.directionBName || '下り';
    }

    let status: JourneyState['status'] = 'TRACKING';
    if (confidence < this.config.confidenceMedium) {
      status = 'ROUTE_UNCERTAIN';
    }

    return {
      line: selectedLine,
      direction,
      directionName,
      previousStation,
      nextStation,
      distanceToNextStationMeters,
      confidence,
      status,
    };
  }

  public reset(): void {
    this.lastSample = null;
    this.lastConfirmedDirection = 'UNKNOWN';
  }
}
