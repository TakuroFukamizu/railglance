import { describe, it, expect } from 'vitest';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { SpeedEstimator } from '../../src/domain/speed/speed-estimator';
import { LocationSample } from '../../src/domain/models/location';

describe('SpeedEstimator (Multi-Source & Selection)', () => {
  it('adopts OS speed when valid coords.speed is present', () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);
    const sample: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: 25.0, // 90 km/h
      headingDegrees: 45,
      timestampMs: 10000,
    };

    const state = estimator.update(sample, null);
    expect(state.selectedEstimate.source).toBe('os-geolocation');
    expect(state.selectedEstimate.speedKmh).toBe(90.0);
    expect(state.smoothedSpeedKmh).toBe(90.0);
  });

  it('falls back to position-delta speed when OS speed is null', () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);
    const s1: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: null,
      headingDegrees: null,
      timestampMs: 10000,
    };
    const s2: LocationSample = {
      latitude: 35.4536, // ~111m North
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: null,
      headingDegrees: null,
      timestampMs: 15000, // 5 sec later (~80 km/h)
    };

    estimator.update(s1, null);
    const state2 = estimator.update(s2, null);
    expect(state2.selectedEstimate.source).toBe('position-delta');
    expect(state2.selectedEstimate.speedKmh).toBeGreaterThan(50);
  });

  it('adopts track-distance speed when OS speed is null and map match track progress is provided', () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);
    const s1: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 15,
      speedMps: null,
      headingDegrees: null,
      timestampMs: 10000,
    };
    const s2: LocationSample = {
      latitude: 35.4540,
      longitude: 139.3910,
      accuracyMeters: 15,
      speedMps: null,
      headingDegrees: null,
      timestampMs: 15000,
    };

    estimator.update(s1, null, { distanceAlongPolylineMeters: 1000, timestampMs: 10000 });
    // Advanced 125 meters along track polyline in 5 seconds = 25 m/s = 90 km/h
    const state2 = estimator.update(s2, null, { distanceAlongPolylineMeters: 1125, timestampMs: 15000 });

    expect(state2.selectedEstimate.source).toBe('track-distance');
    expect(state2.selectedEstimate.speedKmh).toBe(90.0);
  });

  it('rejects outlier speeds exceeding maxSpeedKmh', () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);
    const sample: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: 150.0, // 540 km/h (> 400 km/h threshold)
      headingDegrees: 45,
      timestampMs: 10000,
    };

    const state = estimator.update(sample, null);
    expect(state.candidates.osSpeed).toBeNull();
  });

  it('prevents speed surge during minor GPS drift when stationary', () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);
    const s1: LocationSample = {
      latitude: 35.452600,
      longitude: 139.390000,
      accuracyMeters: 20,
      speedMps: null,
      headingDegrees: null,
      timestampMs: 10000,
    };
    const s2: LocationSample = {
      latitude: 35.452601,
      longitude: 139.390001,
      accuracyMeters: 20,
      speedMps: null,
      headingDegrees: null,
      timestampMs: 11000,
    };

    estimator.update(s1, null);
    const state2 = estimator.update(s2, null);
    expect(state2.candidates.positionDeltaSpeed?.confidence).toBeLessThan(0.4);
  });

  it('converges to 0 km/h when stopped for 5 seconds', () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);
    const makeStopSample = (ts: number): LocationSample => ({
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 5,
      speedMps: 0.0, // 0 km/h
      headingDegrees: null,
      timestampMs: ts,
    });

    let ts = 10000;
    for (let i = 0; i < 15; i++) {
      estimator.update(makeStopSample(ts), null);
      ts += 1000;
    }
    const finalState = estimator.update(makeStopSample(ts), null);

    expect(finalState.isStopped).toBe(true);
    expect(finalState.smoothedSpeedKmh).toBe(0);
  });

  it('applies EMA smoothing as expected', () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG); // emaAlpha: 0.3
    const s1: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: 0,
      headingDegrees: 0,
      timestampMs: 10000,
    };
    const s2: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: 27.777, // 100 km/h
      headingDegrees: 0,
      timestampMs: 11000,
    };

    estimator.update(s1, null); // initial smoothed: 0
    const state2 = estimator.update(s2, null); // EMA: 0.3 * 100 + 0.7 * 0 = 30 km/h

    expect(state2.selectedEstimate.speedKmh).toBe(100);
    expect(state2.smoothedSpeedKmh).toBe(30);
  });
});
