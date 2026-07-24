import { LocationSample } from '../../domain/models/location';

export interface LocationProvider {
  start(onLocation: (sample: LocationSample) => void, onError?: (err: GeolocationPositionError) => void): void;
  stop(): void;
}

export class BrowserLocationProvider implements LocationProvider {
  private watchId: number | null = null;
  private onLocationCallback: ((sample: LocationSample) => void) | null = null;
  private onErrorCallback: ((err: GeolocationPositionError) => void) | null = null;
  private useHighAccuracy = false;
  private heartbeatTimer: any = null;
  private lastSample: LocationSample | null = null;

  public start(
    onLocation: (sample: LocationSample) => void,
    onError?: (err: GeolocationPositionError) => void
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

    this.heartbeatTimer = setInterval(() => {
      if (this.lastSample && this.onLocationCallback) {
        const refreshedSample: LocationSample = {
          ...this.lastSample,
          timestampMs: Date.now(),
        };
        this.onLocationCallback(refreshedSample);
      }
    }, 3000);
  }

  private startWatch(): void {
    if (!('geolocation' in navigator)) {
      if (this.onErrorCallback) {
        this.onErrorCallback({
          code: 2,
          message: 'Geolocation API is not available on this browser/device.',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
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
    this.lastSample = sample;
    if (this.onLocationCallback) {
      this.onLocationCallback(sample);
    }
  }

  public stop(): void {
    if (this.watchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
