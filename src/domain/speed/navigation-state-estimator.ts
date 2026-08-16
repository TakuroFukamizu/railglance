import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample, TrackNavigationState } from '../models/location';
import { RouteMatch, TrackSegment } from '../models/railway';
import { RoutePositionProjector } from '../railway/route-position-projector';

export interface GpsObservation {
  sample: LocationSample;
  match: RouteMatch | null;
}

export interface MotionObservation {
  /**
   * Signed acceleration along the direction of travel, or null when the device
   * orientation is unknown and no signed longitudinal component can be claimed
   * (the DeviceMotion provider without orientation fusion always reports null).
   */
  trackAccelerationMps2: number | null;
  timestampMs: number;
  isValid: boolean;
  /** True when the accelerometer reports no carriage vibration (train standing). */
  isStillInferred: boolean;
}

export class NavigationStateEstimator {
  private navState: TrackNavigationState;
  private currentSegment: TrackSegment | null = null;
  private projector = new RoutePositionProjector();

  private accelerationDecaySec = 5.0; // Acceleration decay time constant
  private maxTrainSpeedMps = 111.11;  // ~400 km/h
  private stillDecelMps2 = 1.5;       // Braking applied when the accelerometer reports stillness
  private maxSpontaneousAccelMps2 = 0.8; // Fastest a coasted speed may climb without a GPS fix
  private coastingDragMps2 = 0.1;     // Drag applied while coasting past the hold window
  private reacquiringFramesLeft = 0;
  // Hold anchor: the velocity observed by the last accurate fix (pre-blend). null
  // until the first accurate fix; 0 is a valid anchor (train stopped, hold the stop).
  private lastKnownValidVelocityMps: number | null = null;
  private lastMotion: MotionObservation | null = null;

  constructor(private config: TrackingConfig) {
    const now = Date.now();
    this.navState = {
      lineId: null,
      routeId: null,
      segmentId: null,
      direction: 'UNKNOWN',
      trackPositionMeters: null,
      velocityMps: 0,
      accelerationMps2: 0,
      accelerationBiasMps2: 0,
      lastObservationTimestampMs: null,
      lastPredictionTimestampMs: now,
      mode: 'lost',
      confidence: 0.0,
    };
  }

  public getCurrentSegment(): TrackSegment | null {
    return this.currentSegment;
  }

  public setDirection(direction: TrackNavigationState['direction']): void {
    if (direction !== 'UNKNOWN') {
      this.navState.direction = direction;
    }
  }

  public clearRoute(): void {
    this.currentSegment = null;
    this.navState.lineId = null;
    this.navState.routeId = null;
    this.navState.segmentId = null;
    this.navState.direction = 'UNKNOWN';
    this.navState.trackPositionMeters = null;
  }

  /**
   * Time-driven prediction step (runs periodically every 100-250ms).
   * Propagates 1D cumulative route distance and handles segment boundary transitions.
   */
  public predict(nowMs: number, availableSegments?: TrackSegment[]): TrackNavigationState {
    if (this.navState.lastPredictionTimestampMs > nowMs) {
      this.navState.lastPredictionTimestampMs = nowMs;
    }
    const dt = Math.max(0, (nowMs - this.navState.lastPredictionTimestampMs) / 1000);
    this.navState.lastPredictionTimestampMs = nowMs;

    const gpsAgeMs = this.navState.lastObservationTimestampMs !== null
      ? Math.max(0, nowMs - this.navState.lastObservationTimestampMs)
      : Infinity;

    const motionFresh = this.hasFreshMotion(nowMs);
    const motionStill = motionFresh && (this.lastMotion?.isStillInferred ?? false);

    // 1. Dead reckoning velocity prediction & coasting hold logic (Requirements Sec 5.4)
    if (gpsAgeMs > 2000 && this.lastKnownValidVelocityMps !== null) {
      const gpsAgeSec = gpsAgeMs / 1000;
      const anchor = this.lastKnownValidVelocityMps;
      let targetVelocity = anchor;

      if (motionStill) {
        // The accelerometer reports no carriage vibration: the train is standing,
        // regardless of what the hold schedule says. Brake the estimate to 0.
        targetVelocity = Math.max(0, this.navState.velocityMps - this.stillDecelMps2 * dt);
      } else if (gpsAgeSec <= 3) {
        targetVelocity = anchor + this.navState.accelerationMps2 * dt;
      } else if (gpsAgeSec <= 15) {
        targetVelocity = anchor;
      } else if (gpsAgeSec <= 45 || (motionFresh && gpsAgeMs <= this.config.motionCoastingMaxMs)) {
        // Linear drag anchored at the 15s mark. The same absolute-time formula
        // covers the motion-assisted extension past 45s, so the result depends on
        // GPS age only, never on how often predict() happened to run.
        const dragSec = gpsAgeSec - 15;
        targetVelocity = Math.max(0, anchor - this.coastingDragMps2 * dragSec);
      } else {
        targetVelocity = 0;
      }

      // The hold schedule is anchored to the pre-outage fix; never let it climb the
      // estimate back up faster than a train can physically accelerate (this is what
      // resurrects 90 km/h after a stillness stop otherwise).
      targetVelocity = Math.min(
        targetVelocity,
        this.navState.velocityMps + this.maxSpontaneousAccelMps2 * dt
      );

      this.navState.velocityMps = Math.max(0, Math.min(this.maxTrainSpeedMps, targetVelocity));

      if (dt > 0 && this.navState.trackPositionMeters !== null) {
        const directionSign = this.navState.direction === 'DOWN' ? -1 : 1;
        this.navState.trackPositionMeters = Math.max(
          0,
          this.navState.trackPositionMeters + directionSign * this.navState.velocityMps * dt
        );
      }
    } else if (dt > 0 && (this.navState.velocityMps > 0 || this.navState.accelerationMps2 !== 0)) {
      const v = this.navState.velocityMps;
      const a = this.navState.accelerationMps2;
      const vNext = Math.max(0, Math.min(this.maxTrainSpeedMps, v + a * dt));

      if (this.navState.trackPositionMeters !== null) {
        const directionSign = this.navState.direction === 'DOWN' ? -1 : 1;
        this.navState.trackPositionMeters = Math.max(
          0,
          this.navState.trackPositionMeters + directionSign * (v * dt + 0.5 * a * dt * dt)
        );
      }

      this.navState.velocityMps = vNext;
      this.navState.accelerationMps2 = a * Math.exp(-dt / this.accelerationDecaySec);
      if (Math.abs(this.navState.accelerationMps2) < 0.01) {
        this.navState.accelerationMps2 = 0;
      }
    }

    // 2. Track Segment Boundary Transition (Segment Crossing)
    if (this.currentSegment && this.navState.trackPositionMeters !== null && availableSegments) {
      const segmentById = new Map(availableSegments.map((segment) => [segment.id, segment]));
      const maxTransitions = availableSegments.length + 1;

      for (let transitionCount = 0; transitionCount < maxTransitions; transitionCount++) {
        const segment: TrackSegment = this.currentSegment;
        const segStart = segment.startOffsetMeters ?? 0;
        const segEnd = segStart + (segment.lengthMeters ?? 2000);
        const movingDown = this.navState.direction === 'DOWN';
        const crossedBoundary = movingDown
          ? this.navState.trackPositionMeters < segStart
          : this.navState.trackPositionMeters >= segEnd;

        if (!crossedBoundary) break;

        const adjacentIds: string[] | undefined = movingDown
          ? segment.previousSegmentIds
          : segment.nextSegmentIds;
        const adjacent: TrackSegment | undefined = adjacentIds
          ?.map((id: string) => segmentById.get(id))
          .find((candidate): candidate is TrackSegment => candidate !== undefined);
        if (!adjacent) break;

        console.log(
          `[DR Segment Crossing] Transitioning from ${segment.id} -> ${adjacent.id} at offset ${this.navState.trackPositionMeters}m`
        );
        this.currentSegment = adjacent;
        this.navState.segmentId = adjacent.id;
        this.navState.routeId = adjacent.routeId ?? this.navState.routeId;
      }
    }

    // 3. Navigation Mode state machine based on GPS Age
    const motionCoastingActive = motionFresh && gpsAgeMs <= this.config.motionCoastingMaxMs;
    this.updateNavigationMode(gpsAgeMs, false, motionCoastingActive);

    return this.navState;
  }

  /**
   * True while the last accelerometer observation is recent enough to corroborate
   * dead reckoning (and therefore to extend the coasting budget).
   */
  public hasFreshMotion(nowMs: number): boolean {
    if (this.lastMotion === null) return false;
    const ageMs = nowMs - this.lastMotion.timestampMs;
    // Reject future-stamped / out-of-order observations: after a clock skew the
    // extension must not stay latched until the clock catches up.
    return ageMs >= 0 && ageMs <= this.config.motionFreshnessMs;
  }

  /**
   * Observation step with incoming GPS data.
   */
  public updateWithGps(obs: GpsObservation): TrackNavigationState {
    const { sample, match } = obs;
    const nowMs = sample.timestampMs;
    const isLowAccuracy = sample.accuracyMeters > this.config.maxGpsAccuracyMeters;

    const prevMode = this.navState.mode;
    const prevObsTime = this.navState.lastObservationTimestampMs;
    const dtObs = prevObsTime ? (nowMs - prevObsTime) / 1000 : 0;

    const obsVelocityMps = sample.speedMps ?? this.navState.velocityMps;
    let obsTrackPositionMeters: number | null = null;

    if (match) {
      this.currentSegment = match.selectedSegment;
      this.navState.lineId = match.selectedLine.id;
      this.navState.routeId = match.selectedSegment.routeId ?? `route-${match.selectedLine.id}-main`;
      this.navState.segmentId = match.selectedSegment.id;

      const proj = this.projector.projectPointToSegment(sample.latitude, sample.longitude, match.selectedSegment);
      obsTrackPositionMeters = proj.trackPositionMeters;
    }

    // Velocity & Acceleration derivation from GPS
    if (dtObs > 0 && obsVelocityMps !== null) {
      const derivedAccel = (obsVelocityMps - this.navState.velocityMps) / dtObs;
      if (Math.abs(derivedAccel) <= 5.0) {
        this.navState.accelerationMps2 = 0.4 * derivedAccel + 0.6 * this.navState.accelerationMps2;
      }
    }

    // Reacquiring / Smooth Resynchronization logic if returning from dead-reckoning
    if (
      (prevMode === 'dead-reckoning' || prevMode === 'dead-reckoning-low-confidence') &&
      !isLowAccuracy
    ) {
      this.reacquiringFramesLeft = 2; // Keep in reacquiring state for 2 GPS frames for smooth blend
      const correctionWeight = 0.35;

      if (obsTrackPositionMeters !== null && this.navState.trackPositionMeters !== null) {
        this.navState.trackPositionMeters =
          this.navState.trackPositionMeters * (1 - correctionWeight) +
          obsTrackPositionMeters * correctionWeight;
      } else {
        this.navState.trackPositionMeters = obsTrackPositionMeters;
      }

      this.navState.velocityMps =
        this.navState.velocityMps * (1 - correctionWeight) + obsVelocityMps * correctionWeight;
    } else {
      this.navState.velocityMps = obsVelocityMps;
      if (obsTrackPositionMeters !== null) {
        this.navState.trackPositionMeters = obsTrackPositionMeters;
      }
    }

    if (!isLowAccuracy) {
      // A clean 0-speed fix is valid information: if GPS dies right after the train
      // stopped, the hold schedule must anchor to 0, not to the pre-braking speed.
      // The anchor takes the OBSERVED velocity, not the reacquiring-blended one -
      // the blend smooths the display, but a 0 km/h fix interrupted by a second
      // outage must not resurrect the blended ~56 km/h.
      this.lastKnownValidVelocityMps = obsVelocityMps;
      if (obsVelocityMps < 0.5) {
        // A stopped train has no acceleration. The stop fix itself cannot clear the
        // blended accelerationMps2 (its huge negative delta is outlier-rejected), so
        // without this the <=3s DR branch re-accelerates the stopped train.
        this.navState.accelerationMps2 = 0;
      }
    }

    this.navState.lastObservationTimestampMs = nowMs;
    this.navState.lastPredictionTimestampMs = nowMs;

    const gpsAgeMs = 0;
    this.updateNavigationMode(gpsAgeMs, isLowAccuracy);

    return this.navState;
  }

  /**
   * Observation step with motion sensor data.
   */
  public updateWithMotion(motion: MotionObservation): TrackNavigationState {
    if (!motion.isValid) return this.navState;

    this.lastMotion = motion;

    if (motion.trackAccelerationMps2 !== null) {
      const correctedAccel = motion.trackAccelerationMps2 - this.navState.accelerationBiasMps2;
      this.navState.accelerationMps2 = 0.3 * correctedAccel + 0.7 * this.navState.accelerationMps2;
    }
    return this.navState;
  }

  private updateNavigationMode(gpsAgeMs: number, isLowAccuracy = false, motionCoastingActive = false): void {
    // The reacquiring hold only survives while fixes keep arriving. If GPS dies
    // again before the blend frames are consumed, drop the hold so the mode ages
    // back through gps-degraded -> dead-reckoning -> lost instead of pinning
    // 'reacquiring' (confidence 0.85) - and the HUD route layout with it - forever.
    if (this.reacquiringFramesLeft > 0 && gpsAgeMs > 2000) {
      this.reacquiringFramesLeft = 0;
    }

    if (this.reacquiringFramesLeft > 0) {
      this.navState.mode = 'reacquiring';
      this.navState.confidence = 0.85;
      if (gpsAgeMs === 0) {
        this.reacquiringFramesLeft--;
      }
      return;
    }

    if (gpsAgeMs <= 2000) {
      this.navState.mode = isLowAccuracy ? 'gps-degraded' : 'gps-locked';
      this.navState.confidence = isLowAccuracy ? 0.6 : 0.95;
    } else if (gpsAgeMs <= 5000) {
      this.navState.mode = 'gps-degraded';
      this.navState.confidence = 0.75;
    } else if (gpsAgeMs <= 20000) {
      this.navState.mode = 'dead-reckoning';
      const drRatio = (gpsAgeMs - 5000) / 15000;
      this.navState.confidence = Math.max(0.4, 0.75 - drRatio * 0.35);
    } else if (gpsAgeMs <= 60000) {
      this.navState.mode = 'dead-reckoning-low-confidence';
      const drRatio = (gpsAgeMs - 20000) / 40000;
      this.navState.confidence = Math.max(0.15, 0.4 - drRatio * 0.25);
    } else if (motionCoastingActive) {
      // Fresh accelerometer data corroborates the dead-reckoning estimate: defer the
      // lost declaration until the motion-assisted coasting budget expires too.
      this.navState.mode = 'dead-reckoning-low-confidence';
      this.navState.confidence = 0.15;
    } else {
      this.navState.mode = 'lost';
      this.navState.confidence = 0.0;
    }
  }

  public getState(): TrackNavigationState {
    return this.navState;
  }

  public reset(reason = 'manual'): void {
    console.log(`[NavigationStateEstimator] Resetting state (reason: ${reason})`);
    const now = Date.now();
    this.reacquiringFramesLeft = 0;
    this.lastKnownValidVelocityMps = null;
    this.lastMotion = null;
    this.currentSegment = null;
    this.navState = {
      lineId: null,
      routeId: null,
      segmentId: null,
      direction: 'UNKNOWN',
      trackPositionMeters: null,
      velocityMps: 0,
      accelerationMps2: 0,
      accelerationBiasMps2: 0,
      lastObservationTimestampMs: null,
      lastPredictionTimestampMs: now,
      mode: 'lost',
      confidence: 0.0,
    };
  }
}
