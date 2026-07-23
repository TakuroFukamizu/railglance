import { describe, it, expect } from 'vitest';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { SpeedEstimator } from '../../src/domain/speed/speed-estimator';
import { LocationSample } from '../../src/domain/models/location';

describe('SpeedEstimator', () => {
  it('converts speed from m/s to km/h and applies smoothing', () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);
    const sample: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: 25.0, // 90 km/h
      headingDegrees: 45,
      timestampMs: 10000,
    };

    const estimate = estimator.update(sample);
    expect(estimate.isValid).toBe(true);
    expect(estimate.rawSpeedKmh).toBe(90.0);
    expect(estimate.speedKmh).toBe(90.0);
  });

  it('discards extreme low accuracy samples (> maxGpsAccuracyMeters)', () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);
    const sample: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 600, // > 500m threshold
      speedMps: 25.0,
      headingDegrees: 45,
      timestampMs: 10000,
    };

    const estimate = estimator.update(sample);
    expect(estimate.isValid).toBe(false);
  });

  it('calculates speed from distance/time when coords.speed is null', () => {
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
      timestampMs: 15000, // 5 seconds later
    };

    estimator.update(s1);
    const est2 = estimator.update(s2);
    expect(est2.isValid).toBe(true);
    expect(est2.source).toBe('calculated');
    expect(est2.speedKmh).toBeGreaterThan(50);
  });

  it('detects stop when speed remains under 3km/h for 5 seconds', () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);
    let now = 10000;
    const lowSpeedSample = (): LocationSample => ({
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 5,
      speedMps: 0.2, // ~0.72 km/h
      headingDegrees: null,
      timestampMs: now,
    });

    estimator.update(lowSpeedSample());
    now += 2000;
    estimator.update(lowSpeedSample());
    now += 4000; // Total 6s elapsed
    const finalEst = estimator.update(lowSpeedSample());

    expect(finalEst.isStopped).toBe(true);
    expect(finalEst.speedKmh).toBe(0);
  });
});
