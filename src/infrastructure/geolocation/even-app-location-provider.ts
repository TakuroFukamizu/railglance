import {
  AppLocation,
  AppLocationAccuracy,
  EvenAppBridge,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { LocationSample } from '../../domain/models/location';
import { BrowserLocationProvider, LocationProvider, LocationProviderError } from './browser-location-provider';

export class EvenAppUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvenAppUnavailableError';
  }
}

export class EvenAppLocationProvider implements LocationProvider {
  private bridge: EvenAppBridge | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;

  public async start(
    onLocation: (sample: LocationSample) => void,
    onError?: (err: LocationProviderError) => void
  ): Promise<void> {
    if (this.started) return;

    try {
      this.bridge = await waitForEvenAppBridge();
      this.unsubscribe = this.bridge.onAppLocationChanged((location) => {
        onLocation(this.toSample(location));
      });

      const initial = await this.bridge.getAppLocation({
        accuracy: AppLocationAccuracy.High,
        timeoutMs: 5000,
      });
      if (initial) onLocation(this.toSample(initial));

      const didStart = await this.bridge.startAppLocationUpdates({
        accuracy: AppLocationAccuracy.High,
        intervalMs: 1000,
        distanceFilter: 0,
      });
      if (!didStart) {
        throw new Error('Even App location updates could not be started');
      }
      this.started = true;
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      const normalized = error instanceof Error ? error : new Error(String(error));
      onError?.({ message: normalized.message });
      if (!this.bridge) {
        throw new EvenAppUnavailableError(`Even App bridge is unavailable: ${normalized.message}`, {
          cause: normalized,
        });
      }
      throw normalized;
    }
  }

  public async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.bridge && this.started) {
      await this.bridge.stopAppLocationUpdates().catch((error) => {
        console.warn('[EvenAppLocationProvider] Failed to stop location updates:', error);
      });
    }
    this.started = false;
  }

  private toSample(location: AppLocation): LocationSample {
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracyMeters: location.accuracy ?? Number.POSITIVE_INFINITY,
      speedMps: location.speed ?? null,
      headingDegrees: location.heading ?? null,
      timestampMs: location.timestamp ?? Date.now(),
    };
  }
}

export class AdaptiveLocationProvider implements LocationProvider {
  private activeProvider: LocationProvider | null = null;

  constructor(
    private primary: LocationProvider = new EvenAppLocationProvider(),
    private fallback: LocationProvider = new BrowserLocationProvider()
  ) {}

  public async start(
    onLocation: (sample: LocationSample) => void,
    onError?: (err: LocationProviderError) => void
  ): Promise<void> {
    try {
      await this.primary.start(onLocation, onError);
      this.activeProvider = this.primary;
    } catch (primaryError) {
      if (!(primaryError instanceof EvenAppUnavailableError)) throw primaryError;
      console.warn('[AdaptiveLocationProvider] Falling back to browser geolocation:', primaryError);
      await this.fallback.start(onLocation, onError);
      this.activeProvider = this.fallback;
    }
  }

  public async stop(): Promise<void> {
    await this.activeProvider?.stop();
    this.activeProvider = null;
  }
}

export function isEvenAppRuntime(): boolean {
  return typeof window !== 'undefined' &&
    typeof (window as any).flutter_inappwebview?.callHandler === 'function';
}
