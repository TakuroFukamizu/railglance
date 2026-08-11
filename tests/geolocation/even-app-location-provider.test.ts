import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  bridge: {
    onAppLocationChanged: vi.fn(),
    getAppLocation: vi.fn(),
    startAppLocationUpdates: vi.fn(),
    stopAppLocationUpdates: vi.fn(),
  },
  waitForEvenAppBridge: vi.fn(),
}));

vi.mock('@evenrealities/even_hub_sdk', () => ({
  AppLocationAccuracy: { High: 'high' },
  waitForEvenAppBridge: sdk.waitForEvenAppBridge,
}));

import {
  AdaptiveLocationProvider,
  EvenAppUnavailableError,
  EvenAppLocationProvider,
} from '../../src/infrastructure/geolocation/even-app-location-provider';
import { LocationProvider } from '../../src/infrastructure/geolocation/browser-location-provider';

describe('EvenAppLocationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { flutter_inappwebview: { callHandler: vi.fn() } });
    sdk.waitForEvenAppBridge.mockResolvedValue(sdk.bridge);
    sdk.bridge.getAppLocation.mockResolvedValue({
      latitude: 35.6812,
      longitude: 139.7671,
      accuracy: 4,
      speed: 12,
      heading: 30,
      timestamp: 1234,
    });
    sdk.bridge.startAppLocationUpdates.mockResolvedValue(true);
    sdk.bridge.stopAppLocationUpdates.mockResolvedValue(true);
    sdk.bridge.onAppLocationChanged.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses SDK App Location timestamps and releases both native and JS subscriptions', async () => {
    const provider = new EvenAppLocationProvider();
    const onLocation = vi.fn();
    const unsubscribe = vi.fn();
    sdk.bridge.onAppLocationChanged.mockReturnValue(unsubscribe);

    await provider.start(onLocation);
    expect(onLocation).toHaveBeenCalledWith(expect.objectContaining({
      latitude: 35.6812,
      timestampMs: 1234,
      speedMps: 12,
    }));
    expect(sdk.bridge.startAppLocationUpdates).toHaveBeenCalledWith({
      accuracy: 'high',
      intervalMs: 1000,
      distanceFilter: 0,
    });

    await provider.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(sdk.bridge.stopAppLocationUpdates).toHaveBeenCalledOnce();
  });

  it('uses the browser fallback only when the SDK provider cannot start', async () => {
    const primary: LocationProvider = {
      start: vi.fn().mockRejectedValue(new EvenAppUnavailableError('SDK unavailable')),
      stop: vi.fn(),
    };
    const fallback: LocationProvider = {
      start: vi.fn(),
      stop: vi.fn(),
    };
    const provider = new AdaptiveLocationProvider(primary, fallback);

    await provider.start(vi.fn());
    expect(fallback.start).toHaveBeenCalledOnce();
    await provider.stop();
    expect(fallback.stop).toHaveBeenCalledOnce();
  });

  it('uses browser geolocation immediately outside the Even App runtime', async () => {
    vi.unstubAllGlobals();
    const primary: LocationProvider = { start: vi.fn(), stop: vi.fn() };
    const fallback: LocationProvider = { start: vi.fn(), stop: vi.fn() };
    const provider = new AdaptiveLocationProvider(primary, fallback);

    await provider.start(vi.fn());

    expect(primary.start).not.toHaveBeenCalled();
    expect(fallback.start).toHaveBeenCalledOnce();
  });

  it('does not hide an SDK location failure behind browser geolocation', async () => {
    const primary: LocationProvider = {
      start: vi.fn().mockRejectedValue(new Error('Location permission denied')),
      stop: vi.fn(),
    };
    const fallback: LocationProvider = { start: vi.fn(), stop: vi.fn() };
    const provider = new AdaptiveLocationProvider(primary, fallback);

    await expect(provider.start(vi.fn())).rejects.toThrow(/permission denied/);
    expect(fallback.start).not.toHaveBeenCalled();
  });
});
