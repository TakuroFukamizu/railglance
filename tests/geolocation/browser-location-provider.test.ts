import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserLocationProvider } from '../../src/infrastructure/geolocation/browser-location-provider';

describe('BrowserLocationProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not synthesize fresh location observations when GPS stops', () => {
    vi.useFakeTimers();
    let watchSuccess: PositionCallback | undefined;
    const clearWatch = vi.fn();
    const geolocation = {
      getCurrentPosition: vi.fn(),
      watchPosition: vi.fn((success: PositionCallback) => {
        watchSuccess = success;
        return 7;
      }),
      clearWatch,
    };
    vi.stubGlobal('navigator', { geolocation });

    const samples: number[] = [];
    const provider = new BrowserLocationProvider();
    provider.start((sample) => samples.push(sample.timestampMs));

    watchSuccess?.({
      coords: {
        latitude: 35,
        longitude: 139,
        accuracy: 10,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: 20,
        toJSON: () => ({}),
      },
      timestamp: 1000,
      toJSON: () => ({}),
    });

    vi.advanceTimersByTime(30_000);
    expect(samples).toEqual([1000]);

    provider.stop();
    expect(clearWatch).toHaveBeenCalledWith(7);
  });
});
