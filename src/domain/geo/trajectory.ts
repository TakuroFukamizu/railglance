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
 * Representative heading from recent GPS movement, preferred over a single-fix
 * device heading. Low-speed / short-distance windows are marked unreliable.
 */
export function computeTrajectory(
  history: LocationSample[],
  nowMs: number,
  config: TrackingConfig,
  stopped: boolean
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
    !stopped &&
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
  sample: LocationSample
): number | null {
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
