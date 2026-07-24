import { LocationSample, FullSpeedState } from '../../domain/models/location';
import { JourneyState, RouteMatch } from '../../domain/models/railway';
import { HudViewModel } from '../../domain/models/hud';

export type EstimationLogEntry = {
  timestampMs: number;
  rawLocation: LocationSample | null;
  speedState: FullSpeedState;
  match: RouteMatch | null;
  journey: JourneyState;
  hudViewModel: HudViewModel;
};

export class EstimationLogger {
  private listeners: Array<(entry: EstimationLogEntry) => void> = [];

  public subscribe(listener: (entry: EstimationLogEntry) => void): void {
    this.listeners.push(listener);
  }

  public log(entry: EstimationLogEntry): void {
    const { speedState, rawLocation } = entry;
    const { candidates, selectedEstimate, smoothedSpeedKmh } = speedState;

    console.log('[EstimationLog]', {
      time: new Date(entry.timestampMs).toISOString(),
      rawGpsSpeed: candidates.osSpeed?.speedKmh ?? null,
      deltaSpeed: candidates.positionDeltaSpeed?.speedKmh ?? null,
      trackSpeed: candidates.trackDistanceSpeed?.speedKmh ?? null,
      selectedSpeed: selectedEstimate.speedKmh,
      selectedSource: selectedEstimate.source,
      confidence: selectedEstimate.confidence,
      emaOutputSpeed: smoothedSpeedKmh,
      gpsAccuracyMeters: rawLocation?.accuracyMeters ?? null,
      selectedLine: entry.match?.selectedLine.name ?? 'None',
    });

    for (const listener of this.listeners) {
      listener(entry);
    }
  }
}
