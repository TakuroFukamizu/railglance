import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample, SpeedEstimate, FullSpeedState, MultiSpeedCandidates } from '../models/location';
import { haversineDistance } from '../geo/distance';
import { SpeedFilter } from './speed-filter';
import { DefaultSpeedSelector, SpeedSelector } from './speed-selector';

export class SpeedEstimator {
  private lastGpsSample: LocationSample | null = null;
  private lastTrackDistanceMeters: number | null = null;
  private lastTrackTimestampMs: number = 0;

  private speedFilter: SpeedFilter;
  private speedSelector: SpeedSelector;
  private lastFullState: FullSpeedState | null = null;

  constructor(
    private config: TrackingConfig,
    customSelector?: SpeedSelector
  ) {
    this.speedFilter = new SpeedFilter(config);
    this.speedSelector = customSelector ?? new DefaultSpeedSelector();
  }

  /**
   * Updates speed estimation using incoming LocationSample and optional track distance progress.
   */
  public update(
    sample: LocationSample,
    trackProgress?: { distanceAlongPolylineMeters: number; timestampMs: number }
  ): FullSpeedState {
    const timestamp = sample.timestampMs;
    const isLowAccuracy = sample.accuracyMeters > this.config.maxGpsAccuracyMeters;

    // 1. Candidate A: OS Geolocation speed (coords.speed)
    let osEstimate: SpeedEstimate | null = null;
    if (sample.speedMps !== null && sample.speedMps >= 0) {
      const speedKmh = Math.round(sample.speedMps * 3.6 * 10) / 10;
      if (speedKmh <= this.config.maxSpeedKmh) {
        let confidence = 0.9;
        if (isLowAccuracy) confidence *= 0.5;
        osEstimate = {
          speedKmh,
          confidence: Math.round(confidence * 100) / 100,
          source: 'os-geolocation',
          timestamp,
        };
      }
    }

    // 2. Candidate B: Position Delta speed (Haversine distance / time)
    let deltaEstimate: SpeedEstimate | null = null;
    if (this.lastGpsSample) {
      const elapsedSec = (timestamp - this.lastGpsSample.timestampMs) / 1000;
      if (elapsedSec > 0) {
        const distMeters = haversineDistance(
          this.lastGpsSample.latitude,
          this.lastGpsSample.longitude,
          sample.latitude,
          sample.longitude
        );
        const calcSpeedKmh = Math.round((distMeters / elapsedSec) * 3.6 * 10) / 10;

        if (calcSpeedKmh <= this.config.maxSpeedKmh) {
          let confidence = 0.7;
          if (isLowAccuracy) confidence *= 0.4;
          if (distMeters < 3) confidence *= 0.3; // Ignore GPS drift
          deltaEstimate = {
            speedKmh: calcSpeedKmh,
            confidence: Math.round(confidence * 100) / 100,
            source: 'position-delta',
            timestamp,
          };
        }
      }
    }

    // 3. Candidate C: Track Distance speed (Polyline distance / time)
    let trackEstimate: SpeedEstimate | null = null;
    if (trackProgress) {
      if (
        this.lastTrackDistanceMeters !== null &&
        this.lastTrackTimestampMs > 0
      ) {
        const elapsedSec = (trackProgress.timestampMs - this.lastTrackTimestampMs) / 1000;
        if (elapsedSec > 0) {
          const deltaTrackMeters = Math.abs(
            trackProgress.distanceAlongPolylineMeters - this.lastTrackDistanceMeters
          );
          const trackSpeedKmh = Math.round((deltaTrackMeters / elapsedSec) * 3.6 * 10) / 10;

          if (trackSpeedKmh <= this.config.maxSpeedKmh) {
            let confidence = 0.85; // Track distance is stable on curves
            if (isLowAccuracy) confidence *= 0.6;
            trackEstimate = {
              speedKmh: trackSpeedKmh,
              confidence: Math.round(confidence * 100) / 100,
              source: 'track-distance',
              timestamp: trackProgress.timestampMs,
            };
          }
        }
      }
      this.lastTrackDistanceMeters = trackProgress.distanceAlongPolylineMeters;
      this.lastTrackTimestampMs = trackProgress.timestampMs;
    }

    this.lastGpsSample = sample;

    const candidates: MultiSpeedCandidates = {
      osSpeed: osEstimate,
      positionDeltaSpeed: deltaEstimate,
      trackDistanceSpeed: trackEstimate,
      sensorFusionSpeed: null, // Reserved for Phase 2/3
    };

    const candidateList: SpeedEstimate[] = [
      ...(osEstimate ? [osEstimate] : []),
      ...(deltaEstimate ? [deltaEstimate] : []),
      ...(trackEstimate ? [trackEstimate] : []),
    ];

    // 4. Select best speed candidate using SpeedSelector
    const selectedEstimate = this.speedSelector.select(candidateList);

    // 5. Filter selected speed (EMA, outlier rejection, stop detection)
    const rawSpeedKmh = selectedEstimate.speedKmh ?? 0;
    const { smoothedKmh, isStopped } = this.speedFilter.filter(rawSpeedKmh, timestamp);

    const fullState: FullSpeedState = {
      selectedEstimate,
      smoothedSpeedKmh: selectedEstimate.speedKmh !== null ? smoothedKmh : null,
      isStopped,
      isValid: !isLowAccuracy && selectedEstimate.source !== 'unknown',
      candidates,
    };

    this.lastFullState = fullState;
    return fullState;
  }

  public getEstimateAt(currentTimeMs: number): FullSpeedState {
    if (!this.lastFullState) {
      const unknownEstimate: SpeedEstimate = {
        speedKmh: null,
        confidence: 0.0,
        source: 'unknown',
        timestamp: currentTimeMs,
      };
      return {
        selectedEstimate: unknownEstimate,
        smoothedSpeedKmh: null,
        isStopped: false,
        isValid: false,
        candidates: {
          osSpeed: null,
          positionDeltaSpeed: null,
          trackDistanceSpeed: null,
          sensorFusionSpeed: null,
        },
      };
    }

    if (currentTimeMs - this.lastFullState.selectedEstimate.timestamp > this.config.staleLocationMs) {
      const unknownEstimate: SpeedEstimate = {
        speedKmh: null,
        confidence: 0.0,
        source: 'unknown',
        timestamp: currentTimeMs,
      };
      return {
        ...this.lastFullState,
        selectedEstimate: unknownEstimate,
        smoothedSpeedKmh: null,
        isValid: false,
      };
    }

    return this.lastFullState;
  }

  public reset(): void {
    this.lastGpsSample = null;
    this.lastTrackDistanceMeters = null;
    this.lastTrackTimestampMs = 0;
    this.lastFullState = null;
    this.speedFilter.reset();
  }
}
