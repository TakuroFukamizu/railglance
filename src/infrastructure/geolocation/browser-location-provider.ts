import { LocationSample } from '../../domain/models/location';

export interface LocationProvider {
  start(onLocation: (sample: LocationSample) => void, onError?: (err: LocationProviderError) => void): void | Promise<void>;
  stop(): void | Promise<void>;
}

export type LocationProviderError = {
  code?: number;
  message: string;
};

export class BrowserLocationProvider implements LocationProvider {
  private watchId: number | null = null;
  private onLocationCallback: ((sample: LocationSample) => void) | null = null;
  private onErrorCallback: ((err: LocationProviderError) => void) | null = null;
  private useHighAccuracy = false;

  public start(
    onLocation: (sample: LocationSample) => void,
    onError?: (err: LocationProviderError) => void
  ): void {
    this.onLocationCallback = onLocation;
    this.onErrorCallback = onError ?? null;

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => this.handleSuccess(pos),
        (err) => console.warn('[LocationProvider] getCurrentPosition failed, relying on watchPosition:', err.message),
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 10000 }
      );
    }

    this.startWatch();

  }

  private startWatch(): void {
    if (!('geolocation' in navigator)) {
      if (this.onErrorCallback) {
        this.onErrorCallback({
          code: 2,
          message: 'Geolocation API is not available on this browser/device.',
        });
      }
      return;
    }

    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
    }

    const options: PositionOptions = {
      enableHighAccuracy: this.useHighAccuracy,
      maximumAge: 5000,
      timeout: 15000,
    };

    console.log(`[LocationProvider] watchPosition active (highAccuracy: ${this.useHighAccuracy})`);

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handleSuccess(pos),
      (err) => {
        console.warn(`[LocationProvider] Error code ${err.code}: ${err.message}`);
        if (this.onErrorCallback) {
          this.onErrorCallback(err);
        }
      },
      options
    );
  }

  private handleSuccess(pos: GeolocationPosition): void {
    const sample: LocationSample = {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracyMeters: pos.coords.accuracy,
      speedMps: pos.coords.speed,
      headingDegrees: pos.coords.heading,
      timestampMs: pos.timestamp || Date.now(),
    };
    if (this.onLocationCallback) {
      this.onLocationCallback(sample);
    }
  }

  public stop(): void {
    if (this.watchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
}
