import { SpeedEstimate } from '../models/location';

export interface SpeedSelector {
  select(candidates: SpeedEstimate[]): SpeedEstimate;
}

export class DefaultSpeedSelector implements SpeedSelector {
  private lastSelectedSource: SpeedEstimate['source'] = 'unknown';

  public select(candidates: SpeedEstimate[]): SpeedEstimate {
    const validCandidates = candidates.filter(
      (c) => c.speedKmh !== null && c.confidence > 0
    );

    if (validCandidates.length === 0) {
      return {
        speedKmh: null,
        confidence: 0.0,
        source: 'unknown',
        timestamp: Date.now(),
      };
    }

    const osCand = validCandidates.find((c) => c.source === 'os-geolocation' || c.source === 'reacquired-gps');
    const trackCand = validCandidates.find((c) => c.source === 'track-distance');
    const deltaCand = validCandidates.find((c) => c.source === 'position-delta');
    const drCand = validCandidates.find((c) => c.source === 'dead-reckoning');
    const fusionCand = validCandidates.find((c) => c.source === 'motion-fusion' || c.source === 'sensor-fusion');

    let selected: SpeedEstimate;

    if (osCand && osCand.confidence >= 0.7) {
      selected = osCand;
    } else if (trackCand && trackCand.confidence >= 0.6) {
      selected = trackCand;
    } else if (deltaCand && deltaCand.confidence >= 0.4) {
      selected = deltaCand;
    } else if (drCand && drCand.confidence >= 0.2) {
      selected = drCand;
    } else if (fusionCand && fusionCand.confidence >= 0.2) {
      selected = fusionCand;
    } else {
      validCandidates.sort((a, b) => b.confidence - a.confidence);
      selected = validCandidates[0];
    }

    if (selected.source !== this.lastSelectedSource) {
      console.log(
        `[SpeedSelector] Switched speed source: ${this.lastSelectedSource} -> ${selected.source} (speed: ${selected.speedKmh} km/h, confidence: ${selected.confidence})`
      );
      this.lastSelectedSource = selected.source;
    }

    return selected;
  }
}
