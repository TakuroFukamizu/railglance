import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample, SpeedEstimate, FullSpeedState, MultiSpeedCandidates } from '../models/location';
import { haversineDistance } from '../geo/distance';
import { SpeedFilter } from './speed-filter';
import { DefaultSpeedSelector, SpeedSelector } from './speed-selector';
import { DeviceMotionSensorFusionProvider } from '../../infrastructure/sensors/device-motion-sensor-fusion-provider';
import { NavigationStateEstimator } from './navigation-state-estimator';
import { RouteMatch } from '../models/railway';

export class SpeedEstimator {
  private lastGpsSample: LocationSample | null = null;
  private lastTrackDistanceMeters: number | null = null;
  private lastTrackTimestampMs: number = 0;

  private speedFilter: SpeedFilter;
  private speedSelector: SpeedSelector;
  private sensorFusionProvider: DeviceMotionSensorFusionProvider;
  private navEstimator: NavigationStateEstimator;
  private lastFullState: FullSpeedState | null = null;

  constructor(
    private config: TrackingConfig,
    customSelector?: SpeedSelector
  ) {
    this.speedFilter = new SpeedFilter(config);
    this.speedSelector = customSelector ?? new DefaultSpeedSelector();
    this.sensorFusionProvider = new DeviceMotionSensorFusionProvider();
    this.navEstimator = new NavigationStateEstimator(config);
  }

  /**
   * Updates speed estimation using incoming LocationSample and optional track distance progress.
   */
  public update(
    sample: LocationSample,
    match: RouteMatch | null,
    trackProgress?: { distanceAlongPolylineMeters: number; timestampMs: number }
  ): FullSpeedState {
    const timestamp = sample.timestampMs;
    const isLowAccuracy = sample.accuracyMeters > this.config.maxGpsAccuracyMeters;

    // 1. Update NavigationStateEstimator with GPS observation
    const navState = this.navEstimator.updateWithGps({ sample, match });

    // 2. Candidate A: OS Geolocation speed (coords.speed)
    let osEstimate: SpeedEstimate | null = null;
    if (sample.speedMps !== null && sample.speedMps >= 0) {
      const speedKmh = Math.round(sample.speedMps * 3.6 * 10) / 10;
      if (speedKmh <= this.config.maxSpeedKmh) {
        let confidence = 0.9;
        if (isLowAccuracy) confidence *= 0.5;
        osEstimate = {
          speedKmh,
          confidence: Math.round(confidence * 100) / 100,
          source: navState.mode === 'reacquiring' ? 'reacquired-gps' : 'os-geolocation',
          timestamp,
        };
      }
    }

    // 3. Candidate B: Position Delta speed (Haversine distance / time)
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

    // 4. Candidate C: Track Distance speed (Polyline distance / time)
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
            let confidence = 0.85;
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

    // 5. Candidate D: Dead Reckoning speed from NavigationStateEstimator
    const drSpeedKmh = Math.round(navState.velocityMps * 3.6 * 10) / 10;
    const deadReckoningEstimate: SpeedEstimate = {
      speedKmh: drSpeedKmh,
      confidence: navState.confidence,
      source: 'dead-reckoning',
      timestamp,
      estimated: true,
    };

    this.lastGpsSample = sample;

    const candidateList: SpeedEstimate[] = [
      ...(osEstimate ? [osEstimate] : []),
      ...(deltaEstimate ? [deltaEstimate] : []),
      ...(trackEstimate ? [trackEstimate] : []),
      deadReckoningEstimate,
    ];

    // 6. Select best speed candidate using SpeedSelector
    const selectedEstimate = this.speedSelector.select(candidateList);

    // Update last known speed in Sensor Fusion Provider
    if (selectedEstimate.speedKmh !== null) {
      this.sensorFusionProvider.setLastKnownSpeed(selectedEstimate.speedKmh);
    }

    // 7. Filter selected speed (EMA, outlier rejection, stop detection)
    const rawSpeedKmh = selectedEstimate.speedKmh ?? 0;
    const { smoothedKmh, isStopped } = this.speedFilter.filter(rawSpeedKmh, timestamp);

    const candidates: MultiSpeedCandidates = {
      osSpeed: osEstimate,
      positionDeltaSpeed: deltaEstimate,
      trackDistanceSpeed: trackEstimate,
      deadReckoningSpeed: deadReckoningEstimate,
      sensorFusionSpeed: null,
    };

    const fullState: FullSpeedState = {
      selectedEstimate,
      smoothedSpeedKmh: selectedEstimate.speedKmh !== null ? smoothedKmh : null,
      isStopped,
      isValid: !isLowAccuracy && selectedEstimate.source !== 'unknown',
      candidates,
      navState,
    };

    this.lastFullState = fullState;
    return fullState;
  }

  public async getEstimateAtAsync(currentTimeMs: number): Promise<FullSpeedState> {
    // 1. Run time-driven prediction step on NavigationStateEstimator
    const predictedNavState = this.navEstimator.predict(currentTimeMs);

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
          deadReckoningSpeed: null,
          sensorFusionSpeed: null,
        },
        navState: predictedNavState,
      };
    }

    const timeSinceLastGps = currentTimeMs - (this.lastFullState.navState.lastObservationTimestampMs ?? currentTimeMs);

    // 2. Dead Reckoning Mode during GPS Pause/Tunnel
    if (predictedNavState.mode === 'dead-reckoning' || predictedNavState.mode === 'dead-reckoning-low-confidence') {
      const drSpeedKmh = Math.round(predictedNavState.velocityMps * 3.6 * 10) / 10;
      const drEstimate: SpeedEstimate = {
        speedKmh: drSpeedKmh,
        confidence: predictedNavState.confidence,
        source: 'dead-reckoning',
        timestamp: currentTimeMs,
        estimated: true,
      };

      const { smoothedKmh, isStopped } = this.speedFilter.filter(drSpeedKmh, currentTimeMs);
      return {
        ...this.lastFullState,
        selectedEstimate: drEstimate,
        smoothedSpeedKmh: smoothedKmh,
        isStopped,
        isValid: true,
        navState: predictedNavState,
      };
    }

    // 3. Declare GPS Unavailable only after coastingMaxMs (45 seconds) or when lost
    if (timeSinceLastGps > this.config.staleLocationMs || (predictedNavState.mode as string) === 'lost') {
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
        navState: predictedNavState,
      };
    }

    return {
      ...this.lastFullState,
      navState: predictedNavState,
    };
  }

  public getEstimateAt(currentTimeMs: number): FullSpeedState {
    const predictedNavState = this.navEstimator.predict(currentTimeMs);
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
          deadReckoningSpeed: null,
          sensorFusionSpeed: null,
        },
        navState: predictedNavState,
      };
    }

    return {
      ...this.lastFullState,
      navState: predictedNavState,
    };
  }

  public reset(): void {
    this.lastGpsSample = null;
    this.lastTrackDistanceMeters = null;
    this.lastTrackTimestampMs = 0;
    this.lastFullState = null;
    this.speedFilter.reset();
    this.navEstimator.reset('manual');
  }
}
