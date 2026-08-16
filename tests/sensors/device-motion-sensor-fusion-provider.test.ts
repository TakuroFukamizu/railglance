import { describe, it, expect } from 'vitest';
import { DeviceMotionSensorFusionProvider } from '../../src/infrastructure/sensors/device-motion-sensor-fusion-provider';

const G = 9.80665;
const START_MS = 100000;
const SAMPLE_INTERVAL_MS = 50; // ~20Hz devicemotion

// Feeds `durationMs` worth of samples whose magnitude oscillates around `base`
// with amplitude `wobble` (alternating sign, i.e. vibration).
const feed = (
  provider: DeviceMotionSensorFusionProvider,
  fromMs: number,
  durationMs: number,
  base: number,
  wobble: number,
  includesGravity: boolean
): number => {
  let now = fromMs;
  for (let i = 0; now < fromMs + durationMs; i++) {
    const magnitude = base + (i % 2 === 0 ? wobble : -wobble);
    provider.ingestAccelerationSample(0, 0, magnitude, includesGravity, now);
    now += SAMPLE_INTERVAL_MS;
  }
  return now;
};

describe('DeviceMotionSensorFusionProvider observations', () => {
  it('returns no observation before any devicemotion sample arrived', () => {
    const provider = new DeviceMotionSensorFusionProvider();
    expect(provider.getLatestObservation()).toBeNull();
  });

  it('reports stillness after sustained quiet on gravity-inclusive readings', () => {
    const provider = new DeviceMotionSensorFusionProvider();
    const end = feed(provider, START_MS, 5000, G, 0.005, true);

    const obs = provider.getLatestObservation();
    expect(obs).not.toBeNull();
    expect(obs!.isValid).toBe(true);
    expect(obs!.isStillInferred).toBe(true);
    expect(obs!.timestampMs).toBeLessThanOrEqual(end);
    // No orientation fusion -> no signed longitudinal acceleration claim.
    expect(obs!.trackAccelerationMps2).toBeNull();
  });

  it('reports stillness on gravity-free readings near zero', () => {
    // Regression guard: the old code subtracted 9.8 from a gravity-free magnitude
    // whenever accelerationIncludingGravity happened to exist, so a resting device
    // could never be classified as still.
    const provider = new DeviceMotionSensorFusionProvider();
    feed(provider, START_MS, 5000, 0.01, 0.005, false);

    expect(provider.getLatestObservation()!.isStillInferred).toBe(true);
  });

  it('does not report stillness while carriage vibration is present', () => {
    // A cruising train reads ~9.8 on average but vibrates; averaging the magnitude
    // must not classify it as still.
    const provider = new DeviceMotionSensorFusionProvider();
    feed(provider, START_MS, 5000, G, 0.5, true);

    expect(provider.getLatestObservation()!.isStillInferred).toBe(false);
  });

  it('requires stillness to be sustained before reporting it', () => {
    const provider = new DeviceMotionSensorFusionProvider();
    // Vibrating first, then quiet for only 1s: not yet still.
    const afterVibration = feed(provider, START_MS, 3000, G, 0.5, true);
    feed(provider, afterVibration, 1000, G, 0.005, true);

    expect(provider.getLatestObservation()!.isStillInferred).toBe(false);
  });
});
