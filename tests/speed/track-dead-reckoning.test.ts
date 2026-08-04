import { describe, it, expect, beforeEach } from 'vitest';
import { NavigationStateEstimator } from '../../src/domain/speed/navigation-state-estimator';
import { RoutePositionProjector } from '../../src/domain/railway/route-position-projector';
import { JourneyStateEstimator } from '../../src/domain/railway/journey-state-estimator';
import { DexieRailwayDatabase } from '../../src/infrastructure/storage/dexie-railway-database';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { LocationSample } from '../../src/domain/models/location';
import { TrackSegment } from '../../src/domain/models/railway';

describe('Track-Constrained Dead Reckoning & Segment Crossing', () => {
  let navEstimator: NavigationStateEstimator;
  let projector: RoutePositionProjector;
  let journeyEstimator: JourneyStateEstimator;
  let db: DexieRailwayDatabase;

  const seg1: TrackSegment = {
    id: 'seg-ebina-zama',
    lineId: 'odakyu-odawara',
    routeId: 'route-odakyu-main',
    fromStationId: 'st-ebina',
    toStationId: 'st-zama',
    coordinates: [
      [35.4526, 139.3900],
      [35.4806, 139.4005],
    ],
    lengthMeters: 3300,
    startOffsetMeters: 0,
    nextSegmentIds: ['seg-zama-sobudaimae'],
  };

  const seg2: TrackSegment = {
    id: 'seg-zama-sobudaimae',
    lineId: 'odakyu-odawara',
    routeId: 'route-odakyu-main',
    fromStationId: 'st-zama',
    toStationId: 'st-sobudaimae',
    coordinates: [
      [35.4806, 139.4005],
      [35.4988, 139.4144],
    ],
    lengthMeters: 2400,
    startOffsetMeters: 3300,
    previousSegmentIds: ['seg-ebina-zama'],
  };

  beforeEach(async () => {
    navEstimator = new NavigationStateEstimator(DEFAULT_TRACKING_CONFIG);
    projector = new RoutePositionProjector();
    db = new DexieRailwayDatabase({ remoteBaseUrl: null });
    await db.initialize();
    journeyEstimator = new JourneyStateEstimator(db, DEFAULT_TRACKING_CONFIG);
  });

  it('projects 2D point onto 1D trackPositionMeters and back', () => {
    const proj = projector.projectPointToSegment(35.4526, 139.3900, seg1);
    expect(proj.trackPositionMeters).toBe(0);

    const pt = projector.convertTrackPositionToPoint(0, seg1);
    expect(pt[0]).toBeCloseTo(35.4526, 3);
  });

  it('propagates trackPositionMeters and transitions to nextSegmentId during DR', async () => {
    const sample: LocationSample = {
      latitude: 35.4790,
      longitude: 139.4000,
      accuracyMeters: 10,
      speedMps: 25, // 90 km/h
      headingDegrees: 40,
      timestampMs: 1000000,
    };

    const match: any = {
      selectedLine: { id: 'odakyu-odawara', name: '小田急小田原線' },
      selectedSegment: seg1,
      confidence: 0.9,
    };

    // Initial GPS update
    navEstimator.updateWithGps({ sample, match });

    let state = navEstimator.getState();
    expect(state.trackPositionMeters).toBeGreaterThan(3000);
    expect(navEstimator.getCurrentSegment()?.id).toBe('seg-ebina-zama');

    // Simulate 20 seconds of GPS Tunnel / Outage
    let nowMs = 1000000;
    const availableSegments = [seg1, seg2];

    for (let i = 0; i < 200; i++) {
      nowMs += 100; // 100ms ticks
      state = navEstimator.predict(nowMs, availableSegments);
    }

    expect(state.mode).toMatch(/dead-reckoning/);
    expect(state.trackPositionMeters).toBeGreaterThan(3300); // Crosses seg1 boundary
    expect(navEstimator.getCurrentSegment()?.id).toBe('seg-zama-sobudaimae'); // Segment transition succeeded!

    // Verify JourneyState estimation during DR
    const dummySpeedState: any = { smoothedSpeedKmh: 90, isStopped: false, isValid: true };
    const journey = await journeyEstimator.update(null, null, dummySpeedState, state, navEstimator.getCurrentSegment());

    expect(journey.line?.id).toBe('odakyu-odawara');
    expect(journey.previousStation?.name).toBe('座間');
    expect(journey.nextStation?.name).toBe('相武台前');
    expect(journey.distanceToNextStationMeters).toBeGreaterThanOrEqual(0);
    expect(journey.progressRatio).toBeGreaterThan(0.0);
    expect(journey.progressRatio).toBeLessThanOrEqual(1.0);
  });

  it('moves backward and transitions to previousSegmentId during DOWN dead reckoning', () => {
    const sample: LocationSample = {
      latitude: 35.481,
      longitude: 139.401,
      accuracyMeters: 10,
      speedMps: 25,
      headingDegrees: 220,
      timestampMs: 1_000_000,
    };
    const match: any = {
      selectedLine: { id: 'odakyu-odawara', name: '小田急小田原線' },
      selectedSegment: seg2,
      confidence: 0.9,
    };

    navEstimator.updateWithGps({ sample, match });
    navEstimator.setDirection('DOWN');
    const initialPosition = navEstimator.getState().trackPositionMeters!;

    let state = navEstimator.getState();
    for (let now = 1_000_100; now <= 1_020_000; now += 100) {
      state = navEstimator.predict(now, [seg1, seg2]);
    }

    expect(state.trackPositionMeters).toBeLessThan(initialPosition);
    expect(navEstimator.getCurrentSegment()?.id).toBe('seg-ebina-zama');
  });

  it('crosses multiple connected segments in a single prediction step', () => {
    const shortSegments: TrackSegment[] = [0, 1, 2].map((index) => ({
      id: `short-${index}`,
      lineId: 'line',
      routeId: 'route-line-main',
      fromStationId: `station-${index}`,
      toStationId: `station-${index + 1}`,
      coordinates: [[35 + index * 0.0001, 139], [35 + (index + 1) * 0.0001, 139]],
      lengthMeters: 10,
      startOffsetMeters: index * 10,
      previousSegmentIds: index > 0 ? [`short-${index - 1}`] : [],
      nextSegmentIds: index < 2 ? [`short-${index + 1}`] : [],
    }));
    navEstimator.updateWithGps({
      sample: {
        latitude: 35.00009,
        longitude: 139,
        accuracyMeters: 5,
        speedMps: 50,
        headingDegrees: 0,
        timestampMs: 1_000,
      },
      match: {
        selectedLine: { id: 'line', operatorId: 'op', name: 'Line' },
        selectedSegment: shortSegments[0],
        confidence: 0.9,
        candidates: [],
        timestampMs: 1_000,
      },
    });

    const state = navEstimator.predict(1_500, shortSegments);
    expect(state.trackPositionMeters).toBeGreaterThan(30);
    expect(navEstimator.getCurrentSegment()?.id).toBe('short-2');
  });
});
