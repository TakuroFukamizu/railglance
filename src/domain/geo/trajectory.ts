import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample } from '../models/location';
import { haversineDistance } from './distance';
import { calculateBearing } from './heading';

export type TrajectoryEstimate = {
  headingDegrees: number | null;
  distanceMeters: number;
  durationMs: number;
  sampleCount: number;
  reliable: boolean;
};

/**
 * True when OS speed says the train is stopped. Null when the device did not
 * provide a speed — that is not treated as 0 km/h.
 */
export function osSpeedStopped(sample: LocationSample, config: TrackingConfig): boolean | null {
  if (sample.speedMps === null) return null;
  return sample.speedMps * 3.6 <= config.stopSpeedThresholdKmh;
}

/**
 * Representative heading from recent GPS movement, preferred over a single-fix
 * device heading. Reliability is based only on displacement, not OS speed.
 */
export function computeTrajectory(
  history: LocationSample[],
  nowMs: number,
  config: TrackingConfig
): TrajectoryEstimate {
  const window = history.filter(
    (sample) => nowMs - sample.timestampMs >= 0 && nowMs - sample.timestampMs <= config.routeTrajectoryWindowMs
  );

  if (window.length < 2) {
    return { headingDegrees: null, distanceMeters: 0, durationMs: 0, sampleCount: window.length, reliable: false };
  }

  const oldest = window[0];
  const newest = window[window.length - 1];
  const distanceMeters = haversineDistance(oldest.latitude, oldest.longitude, newest.latitude, newest.longitude);
  const durationMs = Math.max(0, newest.timestampMs - oldest.timestampMs);

  let accumulated = 0;
  for (let i = 1; i < window.length; i++) {
    accumulated += haversineDistance(
      window[i - 1].latitude,
      window[i - 1].longitude,
      window[i].latitude,
      window[i].longitude
    );
  }

  const headingDegrees =
    distanceMeters >= 5
      ? calculateBearing(oldest.latitude, oldest.longitude, newest.latitude, newest.longitude)
      : newest.headingDegrees;

  const reliable =
    distanceMeters >= config.routeTrajectoryMinDistanceMeters &&
    accumulated >= config.routeTrajectoryMinDistanceMeters * 0.6;

  return {
    headingDegrees,
    distanceMeters: Math.round(distanceMeters * 10) / 10,
    durationMs,
    sampleCount: window.length,
    reliable,
  };
}

export function resolveEffectiveHeading(
  trajectory: TrajectoryEstimate,
  sample: LocationSample,
  osStopped: boolean | null
): number | null {
  if (osStopped === true) return sample.headingDegrees;
  if (trajectory.reliable && trajectory.headingDegrees !== null) {
    return trajectory.headingDegrees;
  }
  return sample.headingDegrees;
}

export function trimLocationHistory(
  history: LocationSample[],
  nowMs: number,
  retainMs: number
): LocationSample[] {
  return history.filter((sample) => nowMs - sample.timestampMs >= 0 && nowMs - sample.timestampMs <= retainMs);
}
