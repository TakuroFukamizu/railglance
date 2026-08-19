import { describe, it, expect } from 'vitest';
import { HudRenderer } from '../../src/infrastructure/even-g2/hud-renderer';
import { FullSpeedState, NavigationMode, SpeedEstimate } from '../../src/domain/models/location';
import { JourneyState, RailwayLine, Station } from '../../src/domain/models/railway';

const LAST_GPS_MS = 10000;

const ODAKYU: RailwayLine = { id: 'odakyu-odawara', operatorId: 'odakyu', name: '小田急小田原線' };
const station = (id: string, name: string, sequence: number): Station => ({
  id,
  lineId: ODAKYU.id,
  name,
  sequence,
  latitude: 35.4526,
  longitude: 139.39,
});

const journeyState = (overrides: Partial<JourneyState> = {}): JourneyState => ({
  line: ODAKYU,
  direction: 'UP',
  directionName: '上り',
  previousStation: station('zama', '座間', 1),
  nextStation: station('ebina', '海老名', 2),
  distanceToNextStationMeters: 1200,
  progressRatio: 0.5,
  stationDataComplete: true,
  confidence: 0.9,
  status: 'TRACKING',
  ...overrides,
});

const speedState = (
  selectedEstimate: SpeedEstimate,
  smoothedSpeedKmh: number | null,
  mode: NavigationMode,
  overrides: Partial<FullSpeedState> = {}
): FullSpeedState => ({
  selectedEstimate,
  smoothedSpeedKmh,
  isStopped: false,
  isValid: selectedEstimate.source !== 'unknown',
  candidates: {
    osSpeed: null,
    positionDeltaSpeed: null,
    trackDistanceSpeed: null,
    deadReckoningSpeed: null,
    sensorFusionSpeed: null,
  },
  navState: {
    lineId: null,
    routeId: null,
    segmentId: null,
    direction: 'UNKNOWN',
    trackPositionMeters: null,
    velocityMps: 0,
    accelerationMps2: 0,
    accelerationBiasMps2: 0,
    lastObservationTimestampMs: LAST_GPS_MS,
    lastPredictionTimestampMs: LAST_GPS_MS,
    mode,
    confidence: 0.3,
  },
  ...overrides,
});

describe('HudRenderer status mapping', () => {
  const renderer = new HudRenderer();

  it('shows the dead-reckoning estimate while the estimator is still coasting', () => {
    const nowMs = LAST_GPS_MS + 30000;
    const state = speedState(
      { speedKmh: 82.4, confidence: 0.3, source: 'dead-reckoning', timestamp: nowMs, estimated: true },
      82.4,
      'dead-reckoning-low-confidence'
    );

    const model = renderer.createViewModel(state, journeyState(), nowMs);

    expect(model.statusMode).toBe('DR');
    expect(model.footer.statusRight).toBe('DR 30s');
    expect(model.speed.displaySpeedKmhText).toBe('82');
    expect(model.speed.isEstimated).toBe(true);
  });

  it('reports 測位中 rather than a dead-reckoning footer once the speed is unknown', () => {
    // The nav estimator only declares 'lost' after 60s, so between coastingMaxMs and
    // 60s the speed is unknown while the mode still reads dead-reckoning. The HUD must
    // follow the speed, not the mode, or it pairs a blank speed with "DR 46s".
    const nowMs = LAST_GPS_MS + 46000;
    const state = speedState(
      { speedKmh: null, confidence: 0.0, source: 'unknown', timestamp: nowMs },
      null,
      'dead-reckoning-low-confidence'
    );

    const model = renderer.createViewModel(state, journeyState(), nowMs);

    expect(model.statusMode).toBe('SPEED_UNKNOWN');
    expect(model.footer.statusRight).toBe('測位中');
    expect(model.speed.displaySpeedKmhText).toBe('--');
    // No estimated-value marker on a blank speed.
    expect(model.speed.isEstimated).toBe(false);
    expect(model.rawFormattedText).not.toContain('~');
  });

  it('keeps the route layout while only the speed is unknown', () => {
    // HUD_UI_UX_REQUIREMENTS 14.6 tears the route display down for 位置喪失; that is the
    // navigation state being lost, not the speed expiring, so the line and stations
    // must survive the 45-60s window where the track position is still estimated.
    const nowMs = LAST_GPS_MS + 46000;
    const state = speedState(
      { speedKmh: null, confidence: 0.0, source: 'unknown', timestamp: nowMs },
      null,
      'dead-reckoning-low-confidence'
    );

    const model = renderer.createViewModel(state, journeyState(), nowMs);

    expect(model.header.lineName).toBe('小田急小田原線');
    expect(model.segment.previousStationName).toBe('座間');
    expect(model.segment.nextStationName).toBe('海老名');
    expect(model.rawFormattedText).toContain('小田急小田原線');
    expect(model.rawFormattedText).toContain('座間');
  });

  it('falls back to the lost layout once the navigation state itself is lost', () => {
    const nowMs = LAST_GPS_MS + 61000;
    const state = speedState(
      { speedKmh: null, confidence: 0.0, source: 'unknown', timestamp: nowMs },
      null,
      'lost'
    );

    const model = renderer.createViewModel(state, journeyState(), nowMs);

    expect(model.statusMode).toBe('LOST');
    expect(model.footer.statusRight).toBe('測位中');
    expect(model.rawFormattedText).toContain('路線再特定中');
  });

  it('keeps speed visible and shows 路線判定中 while the route is unresolved', () => {
    const nowMs = LAST_GPS_MS + 1000;
    const state = speedState(
      { speedKmh: 42, confidence: 0.8, source: 'os-geolocation', timestamp: nowMs },
      42,
      'gps-locked'
    );

    const model = renderer.createViewModel(
      state,
      journeyState({
        line: null,
        confidence: 0.3,
        status: 'MATCHING_ROUTE',
        lockState: 'UNRESOLVED',
      }),
      nowMs
    );

    expect(model.header.lineName).toBe('路線判定中');
    expect(model.footer.statusRight).toBe('判定中');
    expect(model.speed.displaySpeedKmhText).toBe('42');
  });

  it('keeps the current line and shows 確認中 while the route is suspicious', () => {
    const nowMs = LAST_GPS_MS + 1000;
    const state = speedState(
      { speedKmh: 78, confidence: 0.8, source: 'os-geolocation', timestamp: nowMs },
      78,
      'gps-locked'
    );

    const model = renderer.createViewModel(
      state,
      journeyState({ lockState: 'SUSPICIOUS', status: 'ROUTE_UNCERTAIN' }),
      nowMs
    );

    expect(model.header.lineName).toBe('小田急小田原線');
    expect(model.footer.statusRight).toBe('確認中');
    expect(model.speed.displaySpeedKmhText).toBe('78');
  });
});
