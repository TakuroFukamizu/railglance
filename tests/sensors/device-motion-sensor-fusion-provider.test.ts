import { afterEach, describe, expect, it, vi } from 'vitest';
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

type GlobalWithWindow = typeof globalThis & { window?: unknown; DeviceMotionEvent?: unknown };

function installWindow(options: {
  secure?: boolean;
  requestPermission?: (() => Promise<string>) | 'absent' | 'missing-api';
}): void {
  const g = globalThis as GlobalWithWindow;
  const win: Record<string, unknown> = {
    isSecureContext: options.secure ?? true,
    addEventListener: () => {},
  };
  if (options.requestPermission !== 'missing-api') {
    const DeviceMotionEvent: Record<string, unknown> = {};
    if (typeof options.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission = options.requestPermission;
    }
    win.DeviceMotionEvent = DeviceMotionEvent;
    g.DeviceMotionEvent = DeviceMotionEvent;
  }
  g.window = win;
}

describe('DeviceMotionSensorFusionProvider permission state', () => {
  afterEach(() => {
    const g = globalThis as GlobalWithWindow;
    delete g.window;
    delete g.DeviceMotionEvent;
    vi.useRealTimers();
  });

  it('starts unknown and notifies subscribers on change', async () => {
    installWindow({ requestPermission: async () => 'granted' });
    const provider = new DeviceMotionSensorFusionProvider();
    const seen: string[] = [];
    const unsubscribe = provider.onPermissionChange((s) => seen.push(s));

    expect(provider.getPermissionStatus()).toBe('unknown');
    await expect(provider.requestPermission()).resolves.toBe(true);
    expect(provider.getPermissionStatus()).toBe('granted');
    expect(seen).toEqual(['granted']);

    unsubscribe();
    provider.ingestAccelerationSample(0, 0, 9.8, true, 1000);
    expect(seen).toEqual(['granted']);
  });

  it('reports unsupported when DeviceMotionEvent is missing', async () => {
    installWindow({ requestPermission: 'missing-api' });
    const provider = new DeviceMotionSensorFusionProvider();
    await expect(provider.requestPermission()).resolves.toBe(false);
    expect(provider.getPermissionStatus()).toBe('unsupported');
  });

  it('reports insecure-context before asking the OS', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    installWindow({ secure: false, requestPermission });
    const provider = new DeviceMotionSensorFusionProvider();
    await expect(provider.requestPermission()).resolves.toBe(false);
    expect(provider.getPermissionStatus()).toBe('insecure-context');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('is granted immediately when the platform has no requestPermission API', async () => {
    installWindow({ requestPermission: 'absent' });
    const provider = new DeviceMotionSensorFusionProvider();
    await expect(provider.requestPermission()).resolves.toBe(true);
    expect(provider.getPermissionStatus()).toBe('granted');
  });

  it('reports denied when the OS denies and no event arrives', async () => {
    vi.useFakeTimers();
    installWindow({ requestPermission: async () => 'denied' });
    const provider = new DeviceMotionSensorFusionProvider();
    const pending = provider.requestPermission();
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(false);
    expect(provider.getPermissionStatus()).toBe('denied');
  });

  it('promotes to granted when an event arrives after a denial', async () => {
    vi.useFakeTimers();
    installWindow({ requestPermission: async () => 'denied' });
    const provider = new DeviceMotionSensorFusionProvider();
    const seen: string[] = [];
    provider.onPermissionChange((s) => seen.push(s));
    const pending = provider.requestPermission();
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    provider.ingestAccelerationSample(0, 0, 9.8, true, 1000);
    expect(provider.getPermissionStatus()).toBe('granted');
    expect(seen).toEqual(['denied', 'granted']);
  });

  it('reports denied when requestPermission throws and nothing arrives', async () => {
    vi.useFakeTimers();
    installWindow({
      requestPermission: async () => {
        throw new Error('boom');
      },
    });
    const provider = new DeviceMotionSensorFusionProvider();
    const pending = provider.requestPermission();
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(false);
    expect(provider.getPermissionStatus()).toBe('denied');
  });
});
