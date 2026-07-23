import { LocationSample, SpeedEstimate } from '../../domain/models/location';
import { JourneyState, RouteMatch } from '../../domain/models/railway';
import { HudViewModel } from '../../domain/models/hud';

export type EstimationLogEntry = {
  timestampMs: number;
  rawLocation: LocationSample | null;
  speed: SpeedEstimate;
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
    console.log('[EstimationLog]', {
      time: new Date(entry.timestampMs).toISOString(),
      rawGps: entry.rawLocation
        ? `${entry.rawLocation.latitude.toFixed(5)}, ${entry.rawLocation.longitude.toFixed(5)} (acc:${entry.rawLocation.accuracyMeters}m)`
        : 'N/A',
      speed: entry.speed.speedKmh !== null ? `${entry.speed.speedKmh} km/h` : 'N/A',
      selectedLine: entry.match?.selectedLine.name ?? 'None',
      selectedSeg: entry.match?.selectedSegment.id ?? 'None',
      confidence: entry.journey.confidence,
      prevStation: entry.journey.previousStation?.name ?? 'None',
      nextStation: entry.journey.nextStation?.name ?? 'None',
      distNext: entry.journey.distanceToNextStationMeters !== null ? `${entry.journey.distanceToNextStationMeters}m` : 'N/A',
    });

    for (const listener of this.listeners) {
      listener(entry);
    }
  }
}
