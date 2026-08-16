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
import {
  DEFAULT_BRIDGE_READY_TIMEOUT_MS,
  resetBridgeHandshakeForTests,
} from '../../src/infrastructure/even-app/bridge-ready';

describe('EvenAppLocationProvider', () => {
  beforeEach(() => {
    resetBridgeHandshakeForTests();
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

/**
 * Same failure mode as the Even G2 adapter handshake: `waitForEvenAppBridge()`
 * resolves on an `evenAppBridgeReady` event the SDK never times out, so inside a
 * WebView where the bridge never materializes `start()` simply never settles.
 * GPS never begins, `onError` never fires, AppController's `.catch` never runs,
 * and — because the browser fallback is gated on `EvenAppUnavailableError` — the
 * designed fallback can never engage. Bounding the wait converts that silent
 * stall into the ordinary unavailability the fallback already handles.
 *
 * Each case carries a short per-test timeout so an unbounded regression fails in
 * about a second rather than waiting out vitest's default.
 */
describe('EvenAppLocationProvider bridge-ready timeout', () => {
  beforeEach(() => {
    resetBridgeHandshakeForTests();
    vi.clearAllMocks();
    vi.stubGlobal('window', { flutter_inappwebview: { callHandler: vi.fn() } });
    // The SDK waits on an `evenAppBridgeReady` event that never arrives.
    sdk.waitForEvenAppBridge.mockReturnValue(new Promise(() => {}));
    sdk.bridge.onAppLocationChanged.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it(
    'reports the stalled handshake instead of waiting on it forever',
    async () => {
      const provider = new EvenAppLocationProvider({ bridgeReadyTimeoutMs: 20 });
      const onLocation = vi.fn();
      const onError = vi.fn();

      // Without a bound this await never settles and the test times out.
      await expect(provider.start(onLocation, onError)).rejects.toBeInstanceOf(
        EvenAppUnavailableError
      );

      // The configured bound must actually reach the timer, not just the default.
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('20ms') })
      );
      expect(onLocation).not.toHaveBeenCalled();
      // No bridge means no subscription and no location request was attempted.
      expect(sdk.bridge.onAppLocationChanged).not.toHaveBeenCalled();
      expect(sdk.bridge.getAppLocation).not.toHaveBeenCalled();
    },
    1000
  );

  it(
    'lets browser geolocation take over when the bridge never becomes ready',
    async () => {
      const primary = new EvenAppLocationProvider({ bridgeReadyTimeoutMs: 20 });
      const fallback: LocationProvider = { start: vi.fn(), stop: vi.fn() };
      const provider = new AdaptiveLocationProvider(primary, fallback);
      const onLocation = vi.fn();

      await provider.start(onLocation);

      expect(fallback.start).toHaveBeenCalledOnce();

      await provider.stop();
      expect(fallback.stop).toHaveBeenCalledOnce();
    },
    1000
  );

  it(
    'still starts normally when the bridge arrives before the bound expires',
    async () => {
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

      const provider = new EvenAppLocationProvider({ bridgeReadyTimeoutMs: 20 });
      const onLocation = vi.fn();

      await provider.start(onLocation);

      expect(onLocation).toHaveBeenCalledWith(
        expect.objectContaining({ latitude: 35.6812, timestampMs: 1234 })
      );
    },
    1000
  );

  it(
    'falls back to the default bound rather than an instant-firing one',
    async () => {
      // Resolve the handshake so the assertion inspects the delay handed to the
      // timer without leaving a live 10s timer behind.
      sdk.waitForEvenAppBridge.mockResolvedValue(sdk.bridge);
      sdk.bridge.getAppLocation.mockResolvedValue(null);
      sdk.bridge.startAppLocationUpdates.mockResolvedValue(true);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      // setTimeout silently substitutes ~1ms for Infinity, so an unvalidated
      // option would expire the handshake before the bridge could ever answer.
      const provider = new EvenAppLocationProvider({
        bridgeReadyTimeoutMs: Number.POSITIVE_INFINITY,
      });
      await provider.start(vi.fn());

      expect(setTimeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        DEFAULT_BRIDGE_READY_TIMEOUT_MS
      );
      expect(
        warn.mock.calls.filter((args) => String(args[0]).includes('bridgeReadyTimeoutMs'))
      ).toHaveLength(1);
    },
    1000
  );
});
