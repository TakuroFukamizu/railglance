import { TrackingConfig } from '../../config/tracking-config';
import {
  LocationSample,
  SpeedEstimate,
  FullSpeedState,
  MultiSpeedCandidates,
  TrackNavigationState,
} from '../models/location';
import { haversineDistance } from '../geo/distance';
import { SpeedFilter } from './speed-filter';
import { DefaultSpeedSelector, SpeedSelector } from './speed-selector';
import { DeviceMotionSensorFusionProvider } from '../../infrastructure/sensors/device-motion-sensor-fusion-provider';
import { SensorFusionProvider } from '../interfaces/sensor-fusion';
import { NavigationStateEstimator } from './navigation-state-estimator';
import { RouteMatch, TrackSegment } from '../models/railway';

export class SpeedEstimator {
  private lastGpsSample: LocationSample | null = null;
  private lastTrackDistanceMeters: number | null = null;
  private lastTrackTimestampMs: number = 0;

  private speedFilter: SpeedFilter;
  private speedSelector: SpeedSelector;
  private sensorFusionProvider: SensorFusionProvider;
  private navEstimator: NavigationStateEstimator;
  private lastFullState: FullSpeedState | null = null;

  constructor(
    private config: TrackingConfig,
    customSelector?: SpeedSelector,
    motionSource?: SensorFusionProvider
  ) {
    this.speedFilter = new SpeedFilter(config);
    this.speedSelector = customSelector ?? new DefaultSpeedSelector();
    this.sensorFusionProvider = motionSource ?? new DeviceMotionSensorFusionProvider();
    this.navEstimator = new NavigationStateEstimator(config);
  }

  public getNavStateEstimator(): NavigationStateEstimator {
    return this.navEstimator;
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
    const isDR = selectedEstimate.source === 'dead-reckoning';
    const { smoothedKmh, isStopped } = this.speedFilter.filter(rawSpeedKmh, timestamp, isDR);

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

  public async getEstimateAtAsync(currentTimeMs: number, availableSegments?: TrackSegment[]): Promise<FullSpeedState> {
    // 1. Feed the latest accelerometer observation, then run the time-driven
    //    prediction step on NavigationStateEstimator with available segments
    this.ingestLatestMotion();
    const predictedNavState = this.navEstimator.predict(currentTimeMs, availableSegments);
    return this.resolveStateAt(currentTimeMs, predictedNavState);
  }

  public getEstimateAt(currentTimeMs: number): FullSpeedState {
    this.ingestLatestMotion();
    const predictedNavState = this.navEstimator.predict(currentTimeMs);
    return this.resolveStateAt(currentTimeMs, predictedNavState);
  }

  /**
   * Pulls the latest devicemotion-derived observation into the navigation
   * estimator. The provider is event-driven; this pull runs on every estimate
   * tick so dead reckoning sees motion data without a push subscription.
   */
  private ingestLatestMotion(): void {
    const observation = this.sensorFusionProvider.getLatestObservation();
    if (observation?.isValid) {
      this.navEstimator.updateWithMotion(observation);
    }
  }

  /**
   * Resolves the reported speed state for a given time, given an already predicted
   * navigation state. Branch priority is:
   *   1. no previous state          -> unknown
   *   2. coasting expired or lost   -> unknown
   *   3. fix stale (or DR mode)     -> dead-reckoning
   *   4. fix still fresh            -> last GPS-derived state
   */
  private resolveStateAt(currentTimeMs: number, predictedNavState: TrackNavigationState): FullSpeedState {
    if (!this.lastFullState) {
      return this.unknownState(currentTimeMs, predictedNavState);
    }

    // Clamp against clock skew: a fix stamped ahead of currentTimeMs counts as age 0,
    // matching how predict() treats gpsAgeMs.
    const timeSinceLastGps = Math.max(
      0,
      currentTimeMs - (this.lastFullState.navState.lastObservationTimestampMs ?? currentTimeMs)
    );

    // 2. GPS considered unavailable: coasting budget exhausted, or navigation state lost.
    //    This is checked BEFORE dead-reckoning so that an expired fix can never be
    //    reported as a coasted speed (issue #20). Fresh accelerometer data extends
    //    the budget (still/moving corroboration); a stale sensor falls straight back.
    const coastingBudgetMs = this.navEstimator.hasFreshMotion(currentTimeMs)
      ? Math.max(this.config.coastingMaxMs, this.config.motionCoastingMaxMs)
      : this.config.coastingMaxMs;
    if (timeSinceLastGps > coastingBudgetMs || predictedNavState.mode === 'lost') {
      // Drop the smoothing state as well. The EMA still holds the speed the train had
      // when GPS died, and nothing feeds it while the speed is unknown, so leaving it
      // in place would blend a minutes-old speed into the first fix after reacquisition.
      this.speedFilter.reset();
      return this.unknownState(currentTimeMs, predictedNavState);
    }

    // 3. Dead Reckoning Mode during GPS Pause/Tunnel (fix is stale but still within
    //    the coasting budget).
    if (
      timeSinceLastGps > this.config.staleLocationMs ||
      predictedNavState.mode === 'dead-reckoning' ||
      predictedNavState.mode === 'dead-reckoning-low-confidence'
    ) {
      const drSpeedKmh = Math.round(predictedNavState.velocityMps * 3.6 * 10) / 10;
      const drEstimate: SpeedEstimate = {
        speedKmh: drSpeedKmh,
        confidence: predictedNavState.confidence,
        source: 'dead-reckoning',
        timestamp: currentTimeMs,
        estimated: true,
      };

      const { smoothedKmh, isStopped } = this.speedFilter.filter(drSpeedKmh, currentTimeMs, true);
      return {
        ...this.lastFullState,
        selectedEstimate: drEstimate,
        smoothedSpeedKmh: smoothedKmh,
        isStopped,
        isValid: true,
        navState: predictedNavState,
      };
    }

    // 4. Fix is still fresh: keep reporting the last GPS-derived state.
    return {
      ...this.lastFullState,
      navState: predictedNavState,
    };
  }

  /**
   * Speed is unknown. Nothing measured before the gap survives here: the per-source
   * candidates and the stop flag describe the last fix, not now, and reporting them
   * would let the HUD claim the train is standing at a station it may have left.
   */
  private unknownState(currentTimeMs: number, navState: TrackNavigationState): FullSpeedState {
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
      navState,
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
