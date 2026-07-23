import { LocationSample } from '../../src/domain/models/location';
import { LocationProvider } from '../../src/infrastructure/geolocation/browser-location-provider';

export class GpsLogReplayer implements LocationProvider {
  private listener: ((sample: LocationSample) => void) | null = null;
  private isReplaying = false;

  constructor(private logSamples: LocationSample[]) {}

  public start(onLocation: (sample: LocationSample) => void): void {
    this.listener = onLocation;
    this.isReplaying = true;
  }

  public stop(): void {
    this.isReplaying = false;
    this.listener = null;
  }

  public async stepAll(intervalMs = 100): Promise<void> {
    if (!this.listener) return;
    for (const sample of this.logSamples) {
      if (!this.isReplaying) break;
      this.listener(sample);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
