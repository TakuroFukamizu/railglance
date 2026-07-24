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

    // Sort by priority and confidence:
    // 1. os-geolocation (if high confidence)
    // 2. track-distance (stable on curves during valid map match)
    // 3. position-delta (fallback GPS calculation)
    // 4. sensor-fusion (reserved)

    const osCand = validCandidates.find((c) => c.source === 'os-geolocation');
    const trackCand = validCandidates.find((c) => c.source === 'track-distance');
    const deltaCand = validCandidates.find((c) => c.source === 'position-delta');

    let selected: SpeedEstimate;

    if (osCand && osCand.confidence >= 0.7) {
      selected = osCand;
    } else if (trackCand && trackCand.confidence >= 0.6) {
      selected = trackCand;
    } else if (deltaCand && deltaCand.confidence >= 0.4) {
      selected = deltaCand;
    } else {
      // Pick highest confidence candidate
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
