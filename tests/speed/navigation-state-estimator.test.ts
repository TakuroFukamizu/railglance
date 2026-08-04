import { describe, it, expect } from 'vitest';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { NavigationStateEstimator } from '../../src/domain/speed/navigation-state-estimator';
import { LocationSample } from '../../src/domain/models/location';

describe('NavigationStateEstimator (Track-Constrained Dead Reckoning)', () => {
  it('updates state with valid GPS observation and sets mode to gps-locked', () => {
    const estimator = new NavigationStateEstimator(DEFAULT_TRACKING_CONFIG);
    const sample: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: 25.0, // 90 km/h
      headingDegrees: 45,
      timestampMs: 10000,
    };

    const state = estimator.updateWithGps({ sample, match: null });
    expect(state.mode).toBe('gps-locked');
    expect(state.velocityMps).toBe(25.0);
    expect(state.confidence).toBeGreaterThan(0.9);
  });

  it('predicts velocity and track position over time with acceleration decay during dead reckoning', () => {
    const estimator = new NavigationStateEstimator(DEFAULT_TRACKING_CONFIG);
    const sample: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: 20.0, // 72 km/h
      headingDegrees: 45,
      timestampMs: 10000,
    };

    estimator.updateWithGps({ sample, match: null });

    // Predict 10 seconds later without new GPS observation (5s to 20s = dead-reckoning mode)
    const statePred = estimator.predict(18000);
    expect(statePred.mode).toBe('dead-reckoning');
    expect(statePred.velocityMps).toBe(20.0);
    expect(statePred.confidence).toBeLessThan(0.8);
  });

  it('transitions mode from dead-reckoning to dead-reckoning-low-confidence after 20 seconds of GPS pause', () => {
    const estimator = new NavigationStateEstimator(DEFAULT_TRACKING_CONFIG);
    const sample: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: 20.0,
      headingDegrees: 45,
      timestampMs: 10000,
    };

    estimator.updateWithGps({ sample, match: null });

    // 25 seconds later (timestamp 35000ms)
    const statePred = estimator.predict(35000);
    expect(statePred.mode).toBe('dead-reckoning-low-confidence');
    expect(statePred.confidence).toBeLessThan(0.4);
  });

  it('enters reacquiring mode and smoothly resynchronizes when GPS returns after dead reckoning', () => {
    const estimator = new NavigationStateEstimator(DEFAULT_TRACKING_CONFIG);
    const sample1: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: 20.0,
      headingDegrees: 45,
      timestampMs: 10000,
    };

    estimator.updateWithGps({ sample: sample1, match: null });

    // Simulate 10 seconds of GPS pause (dead-reckoning)
    estimator.predict(20000);

    // New GPS observation arrives at 21000ms with speed 25.0 m/s
    const sample2: LocationSample = {
      latitude: 35.4550,
      longitude: 139.3920,
      accuracyMeters: 10,
      speedMps: 25.0,
      headingDegrees: 45,
      timestampMs: 21000,
    };

    const reacquiredState = estimator.updateWithGps({ sample: sample2, match: null });
    expect(reacquiredState.mode).toBe('reacquiring');
    // Smooth weighted blend: 20 * 0.65 + 25 * 0.35 = 21.75 m/s
    expect(reacquiredState.velocityMps).toBeCloseTo(21.75, 1);
  });

  it('holds a non-zero coasting speed during a short tunnel and becomes lost after 60 seconds', () => {
    const estimator = new NavigationStateEstimator(DEFAULT_TRACKING_CONFIG);
    estimator.updateWithGps({
      sample: {
        latitude: 35.4526,
        longitude: 139.39,
        accuracyMeters: 5,
        speedMps: 20,
        headingDegrees: 45,
        timestampMs: 10_000,
      },
      match: null,
    });

    const tunnel = estimator.predict(25_000);
    expect(tunnel.mode).toBe('dead-reckoning');
    expect(tunnel.velocityMps).toBe(20);

    const lost = estimator.predict(71_000);
    expect(lost.mode).toBe('lost');
    expect(lost.confidence).toBe(0);
  });
});
