import { describe, it, expect } from 'vitest';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { JourneyStateEstimator, StationDatabaseReader } from '../../src/domain/railway/journey-state-estimator';
import { RailwayLine, RouteMatch, Station, TrackSegment } from '../../src/domain/models/railway';
import { LocationSample, FullSpeedState, SpeedEstimate } from '../../src/domain/models/location';

class MockStationDatabase implements StationDatabaseReader {
  private stations: Station[] = [
    { id: 'st-1', lineId: 'line-1', name: '海老名', sequence: 1, latitude: 35.4526, longitude: 139.3900 },
    { id: 'st-2', lineId: 'line-1', name: '座間', sequence: 2, latitude: 35.4806, longitude: 139.4005 },
    { id: 'st-3', lineId: 'line-1', name: '相武台前', sequence: 3, latitude: 35.4988, longitude: 139.4144 },
  ];

  async getStationsByLine(): Promise<Station[]> {
    return this.stations;
  }
  async getStation(id: string): Promise<Station | undefined> {
    return this.stations.find((s) => s.id === id);
  }
}

describe('JourneyStateEstimator', () => {
  it('correctly estimates UP direction when heading towards increasing sequence stations', async () => {
    const db = new MockStationDatabase();
    const estimator = new JourneyStateEstimator(db, DEFAULT_TRACKING_CONFIG);

    const line: RailwayLine = { id: 'line-1', operatorId: 'odakyu', name: '小田急線', directionAName: '上り', directionBName: '下り' };
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
    expect(state.directionName).toBe('上り');
    expect(state.previousStation?.name).toBe('海老名');
    expect(state.nextStation?.name).toBe('座間');
    expect(state.status).toBe('TRACKING');
  });

  it('correctly estimates DOWN direction when heading towards decreasing sequence stations', async () => {
    const db = new MockStationDatabase();
    const estimator = new JourneyStateEstimator(db, DEFAULT_TRACKING_CONFIG);

    const line: RailwayLine = { id: 'line-1', operatorId: 'odakyu', name: '小田急線', directionAName: '上り', directionBName: '下り' };
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
    expect(state.directionName).toBe('下り');
    expect(state.previousStation?.name).toBe('座間');
    expect(state.nextStation?.name).toBe('海老名');
    expect(state.status).toBe('TRACKING');
  });
});
