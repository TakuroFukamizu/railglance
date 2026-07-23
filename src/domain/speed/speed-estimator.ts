import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample, SpeedEstimate } from '../models/location';
import { haversineDistance } from '../geo/distance';
import { SpeedFilter } from './speed-filter';

export class SpeedEstimator {
  private lastSample: LocationSample | null = null;
  private speedFilter: SpeedFilter;
  private lastValidEstimate: SpeedEstimate | null = null;

  constructor(private config: TrackingConfig) {
    this.speedFilter = new SpeedFilter(config);
  }

  public update(sample: LocationSample): SpeedEstimate {
    // Check extreme low accuracy (> 1000m)
    const isLowAccuracy = sample.accuracyMeters > this.config.maxGpsAccuracyMeters;

    let rawSpeedMps: number | null = null;
    let source: 'gps' | 'calculated' | 'unknown' = 'unknown';

    // 1. Preference 1: coords.speed
    if (sample.speedMps !== null && sample.speedMps >= 0) {
      rawSpeedMps = sample.speedMps;
      source = 'gps';
    } else if (this.lastSample) {
      // 2. Preference 2: distance / time
      const elapsedSeconds = (sample.timestampMs - this.lastSample.timestampMs) / 1000;
      if (elapsedSeconds > 0) {
        const distMeters = haversineDistance(
          this.lastSample.latitude,
          this.lastSample.longitude,
          sample.latitude,
          sample.longitude
        );
        rawSpeedMps = distMeters / elapsedSeconds;
        source = 'calculated';
      }
    }

    this.lastSample = sample;

    // If speed cannot be calculated (e.g. stationary single point fix)
    if (rawSpeedMps === null) {
      const estimate: SpeedEstimate = {
        speedMps: 0,
        speedKmh: 0,
        rawSpeedKmh: 0,
        isStopped: true,
        isValid: !isLowAccuracy,
        timestampMs: sample.timestampMs,
        source: 'unknown',
      };
      this.lastValidEstimate = estimate;
      return estimate;
    }

    const rawSpeedKmh = rawSpeedMps * 3.6;

    // 3. Smooth speed
    const { smoothedKmh, isStopped } = this.speedFilter.filter(rawSpeedKmh, sample.timestampMs);
    const smoothedMps = smoothedKmh / 3.6;

    const estimate: SpeedEstimate = {
      speedMps: smoothedMps,
      speedKmh: smoothedKmh,
      rawSpeedKmh: Math.round(rawSpeedKmh * 10) / 10,
      isStopped,
      isValid: !isLowAccuracy,
      timestampMs: sample.timestampMs,
      source,
    };

    this.lastValidEstimate = estimate;
    return estimate;
  }

  public getEstimateAt(currentTimeMs: number): SpeedEstimate {
    if (!this.lastValidEstimate) {
      return {
        speedMps: null,
        speedKmh: null,
        rawSpeedKmh: null,
        isStopped: false,
        isValid: false,
        timestampMs: currentTimeMs,
        source: 'unknown',
      };
    }

    if (currentTimeMs - this.lastValidEstimate.timestampMs > this.config.staleLocationMs) {
      return {
        speedMps: null,
        speedKmh: null,
        rawSpeedKmh: null,
        isStopped: false,
        isValid: false,
        timestampMs: currentTimeMs,
        source: 'unknown',
      };
    }

    return this.lastValidEstimate;
  }

  public reset(): void {
    this.lastSample = null;
    this.lastValidEstimate = null;
    this.speedFilter.reset();
  }
}
