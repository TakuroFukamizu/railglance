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

describe('SpeedEstimator GPS loss transitions (issue #20)', () => {
  const LAST_GPS_MS = 10000;

  // Seeds the estimator with a single valid 90 km/h fix at LAST_GPS_MS.
  // Every test builds its own estimator and probes a single point in time so that
  // the NavigationStateEstimator prediction trajectory is not shared between cases.
  const seedEstimator = (): SpeedEstimator => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);
    const sample: LocationSample = {
      latitude: 35.4526,
      longitude: 139.3900,
      accuracyMeters: 10,
      speedMps: 25.0, // 90 km/h
      headingDegrees: 45,
      timestampMs: LAST_GPS_MS,
    };
    estimator.update(sample, null);
    return estimator;
  };

  it('keeps the last GPS state while the fix is still fresh (exactly staleLocationMs old)', async () => {
    const estimator = seedEstimator();
    const state = await estimator.getEstimateAtAsync(LAST_GPS_MS + DEFAULT_TRACKING_CONFIG.staleLocationMs);

    expect(state.selectedEstimate.source).toBe('os-geolocation');
    expect(state.smoothedSpeedKmh).toBe(90);
    expect(state.isValid).toBe(true);
  });

  it('switches to dead-reckoning once the fix is stale (~3s after GPS loss)', async () => {
    const estimator = seedEstimator();
    const state = await estimator.getEstimateAtAsync(LAST_GPS_MS + 3000);

    expect(state.selectedEstimate.source).toBe('dead-reckoning');
    expect(state.selectedEstimate.estimated).toBe(true);
    expect(state.selectedEstimate.speedKmh).not.toBeNull();
    expect(state.smoothedSpeedKmh).not.toBeNull();
    expect(state.isValid).toBe(true);
  });

  it('still coasts on dead-reckoning at exactly coastingMaxMs (45s after GPS loss)', async () => {
    const estimator = seedEstimator();
    const state = await estimator.getEstimateAtAsync(LAST_GPS_MS + DEFAULT_TRACKING_CONFIG.coastingMaxMs);

    expect(state.navState.mode).toBe('dead-reckoning-low-confidence');
    expect(state.selectedEstimate.source).toBe('dead-reckoning');
    expect(state.selectedEstimate.speedKmh).not.toBeNull();
    expect(state.smoothedSpeedKmh).not.toBeNull();
  });

  it('reports unknown just past coastingMaxMs even though nav mode is still dead-reckoning', async () => {
    const estimator = seedEstimator();
    const state = await estimator.getEstimateAtAsync(LAST_GPS_MS + DEFAULT_TRACKING_CONFIG.coastingMaxMs + 1000);

    // The nav estimator only declares 'lost' after 60s, so this case is exactly the
    // one the old branch ordering leaked through as a coasted (often 0 km/h) speed.
    expect(state.navState.mode).toBe('dead-reckoning-low-confidence');
    expect(state.selectedEstimate.source).toBe('unknown');
    expect(state.selectedEstimate.speedKmh).toBeNull();
    expect(state.smoothedSpeedKmh).toBeNull();
    expect(state.isValid).toBe(false);
  });

  it('reports unknown 60s after GPS loss', async () => {
    const estimator = seedEstimator();
    const state = await estimator.getEstimateAtAsync(LAST_GPS_MS + 60000);

    expect(state.selectedEstimate.source).toBe('unknown');
    expect(state.smoothedSpeedKmh).toBeNull();
    expect(state.isValid).toBe(false);
  });

  it('reports unknown once the navigation state is lost (>60s after GPS loss)', async () => {
    const estimator = seedEstimator();
    const state = await estimator.getEstimateAtAsync(LAST_GPS_MS + 61000);

    expect(state.navState.mode).toBe('lost');
    expect(state.selectedEstimate.source).toBe('unknown');
    expect(state.smoothedSpeedKmh).toBeNull();
    expect(state.isValid).toBe(false);
  });

  it('applies the same branch priority to the synchronous getEstimateAt()', () => {
    const drState = seedEstimator().getEstimateAt(LAST_GPS_MS + 3000);
    expect(drState.selectedEstimate.source).toBe('dead-reckoning');

    const expiredState = seedEstimator().getEstimateAt(
      LAST_GPS_MS + DEFAULT_TRACKING_CONFIG.coastingMaxMs + 1000
    );
    expect(expiredState.selectedEstimate.source).toBe('unknown');
    expect(expiredState.smoothedSpeedKmh).toBeNull();
    expect(expiredState.isValid).toBe(false);
  });

  it('keeps dead-reckoning coasting alive for the whole budget after GPS is lost', async () => {
    const estimator = seedEstimator();

    // Coasting is driven by NavigationStateEstimator.predict() holding the last valid
    // velocity; if that path ever dies the HUD goes blank the moment GPS drops.
    for (const ageMs of [3000, 10000, 30000, 44000]) {
      const state = await estimator.getEstimateAtAsync(LAST_GPS_MS + ageMs);

      expect(state.selectedEstimate.source).toBe('dead-reckoning');
      expect(state.selectedEstimate.estimated).toBe(true);
      expect(state.selectedEstimate.speedKmh).toBeGreaterThan(0);
      expect(state.smoothedSpeedKmh).toBeGreaterThan(0);
      expect(state.navState.velocityMps).toBeGreaterThan(0);
      expect(state.isValid).toBe(true);
    }
  });

  it('does not blend the frozen pre-outage EMA into the first fix after a long GPS outage', async () => {
    const estimator = seedEstimator();

    // Render loop keeps ticking once a second through a 300s outage (long tunnel).
    const reacquiredAtMs = LAST_GPS_MS + 300000;
    for (let t = LAST_GPS_MS + 1000; t <= reacquiredAtMs; t += 1000) {
      await estimator.getEstimateAtAsync(t);
    }

    // The train has come to a halt by the time GPS returns.
    const state = estimator.update(
      {
        latitude: 35.4526,
        longitude: 139.3900,
        accuracyMeters: 10,
        speedMps: 0,
        headingDegrees: 45,
        timestampMs: reacquiredAtMs,
      },
      null
    );

    expect(state.selectedEstimate.speedKmh).toBe(0);
    // Without clearing the filter the frozen ~84 km/h EMA reappears as ~59 km/h.
    expect(state.smoothedSpeedKmh).toBeLessThan(DEFAULT_TRACKING_CONFIG.stopSpeedThresholdKmh);
  });

  it('stops claiming the train is stopped once the coasting budget expires', async () => {
    const estimator = new SpeedEstimator(DEFAULT_TRACKING_CONFIG);

    // Creep to a halt at a platform so the filter latches isStopped.
    let lastFixMs = LAST_GPS_MS;
    for (let i = 0; i < 20; i++) {
      lastFixMs = LAST_GPS_MS + i * 1000;
      estimator.update(
        {
          latitude: 35.4526,
          longitude: 139.3900,
          accuracyMeters: 10,
          speedMps: 0.2,
          headingDegrees: 45,
          timestampMs: lastFixMs,
        },
        null
      );
    }
    const stopped = await estimator.getEstimateAtAsync(lastFixMs);
    expect(stopped.isStopped).toBe(true);

    // GPS then drops (underground platform) and the coasting budget runs out.
    const expired = await estimator.getEstimateAtAsync(
      lastFixMs + DEFAULT_TRACKING_CONFIG.coastingMaxMs + 1000
    );

    expect(expired.selectedEstimate.source).toBe('unknown');
    // 46s after the last fix the train may well have departed, so neither the stop
    // flag nor the pre-outage per-source candidates may be reported as current.
    expect(expired.isStopped).toBe(false);
    expect(expired.candidates.osSpeed).toBeNull();
    expect(expired.candidates.deadReckoningSpeed).toBeNull();
  });

  // A single fix sneaking through a tunnel gap puts the estimator into the
  // 2-frame reacquiring blend. If GPS dies again before those frames arrive,
  // the reacquiring hold must not pin the mode (confidence 0.85) forever.
  const seedInterruptedReacquisition = async (): Promise<{ estimator: SpeedEstimator; gapFixMs: number }> => {
    const estimator = seedEstimator();
    const gapFixMs = LAST_GPS_MS + 25000;

    // Coast deep into dead reckoning, then one fix gets through.
    await estimator.getEstimateAtAsync(gapFixMs - 1000);
    const reacquired = estimator.update(
      {
        latitude: 35.4526,
        longitude: 139.3900,
        accuracyMeters: 10,
        speedMps: 25.0,
        headingDegrees: 45,
        timestampMs: gapFixMs,
      },
      null
    );
    expect(reacquired.navState.mode).toBe('reacquiring');
    return { estimator, gapFixMs };
  };

  it('resumes age-based mode transitions when GPS dies again mid-reacquisition', async () => {
    const { estimator, gapFixMs } = await seedInterruptedReacquisition();

    const state = await estimator.getEstimateAtAsync(gapFixMs + 10000);

    expect(state.navState.mode).toBe('dead-reckoning');
    expect(state.selectedEstimate.source).toBe('dead-reckoning');
  });

  it('declares lost 60s after a reacquisition was interrupted by a second outage', async () => {
    const { estimator, gapFixMs } = await seedInterruptedReacquisition();

    const state = await estimator.getEstimateAtAsync(gapFixMs + 61000);

    // Without this the HUD keeps the route layout (SPEED_UNKNOWN) forever and
    // never falls back to the LOST screen required by HUD requirements 14.6.
    expect(state.navState.mode).toBe('lost');
    expect(state.selectedEstimate.source).toBe('unknown');
  });

  // How the unknown state reaches the glasses ('--' / 測位中, no estimated marker) is
  // asserted in tests/even-g2/hud-renderer.test.ts so that HUD wording changes do not
  // break the speed estimation suite.
});
