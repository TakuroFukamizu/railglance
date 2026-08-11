import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample, TrackNavigationState } from '../models/location';
import { RouteMatch, TrackSegment } from '../models/railway';
import { RoutePositionProjector } from '../railway/route-position-projector';

export interface GpsObservation {
  sample: LocationSample;
  match: RouteMatch | null;
}

export interface MotionObservation {
  trackAccelerationMps2: number;
  timestampMs: number;
  isValid: boolean;
}

export class NavigationStateEstimator {
  private navState: TrackNavigationState;
  private currentSegment: TrackSegment | null = null;
  private projector = new RoutePositionProjector();

  private accelerationDecaySec = 5.0; // Acceleration decay time constant
  private maxTrainSpeedMps = 111.11;  // ~400 km/h
  private reacquiringFramesLeft = 0;
  private lastKnownValidVelocityMps = 0;

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

    // 1. Dead reckoning velocity prediction & coasting hold logic (Requirements Sec 5.4)
    if (gpsAgeMs > 2000 && this.lastKnownValidVelocityMps > 0) {
      const gpsAgeSec = gpsAgeMs / 1000;
      let targetVelocity = this.lastKnownValidVelocityMps;

      if (gpsAgeSec <= 3) {
        targetVelocity += this.navState.accelerationMps2 * dt;
      } else if (gpsAgeSec <= 15) {
        targetVelocity = this.lastKnownValidVelocityMps;
      } else if (gpsAgeSec <= 45) {
        const dragSec = gpsAgeSec - 15;
        targetVelocity = Math.max(0, this.lastKnownValidVelocityMps - 0.1 * dragSec);
      } else {
        targetVelocity = 0;
      }

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
    this.updateNavigationMode(gpsAgeMs);

    return this.navState;
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

    if (!isLowAccuracy && this.navState.velocityMps > 0) {
      this.lastKnownValidVelocityMps = this.navState.velocityMps;
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

    const correctedAccel = motion.trackAccelerationMps2 - this.navState.accelerationBiasMps2;
    this.navState.accelerationMps2 = 0.3 * correctedAccel + 0.7 * this.navState.accelerationMps2;
    return this.navState;
  }

  private updateNavigationMode(gpsAgeMs: number, isLowAccuracy = false): void {
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
    this.lastKnownValidVelocityMps = 0;
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
