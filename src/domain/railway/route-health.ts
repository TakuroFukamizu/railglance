import { TrackingConfig } from '../../config/tracking-config';
import { calculateHeadingDifference } from '../geo/heading';
import { RouteCandidateScore, RouteHealth } from '../models/railway';

export type RouteObservation = {
  timestampMs: number;
  lineId: string;
  segmentId: string;
  routeId: string | null;
  distanceMeters: number;
  headingDifferenceDegrees: number | null;
  trajectoryHeadingDifferenceDegrees: number | null;
  trackPositionMeters: number | null;
  stationSequence: number | null;
  previousSegmentIds: string[];
  nextSegmentIds: string[];
};

export function emptyRouteHealth(): RouteHealth {
  return {
    distanceConsistency: 0,
    headingConsistency: 0,
    trajectoryConsistency: 0,
    stationSequenceConsistency: 0,
    topologyConsistency: 0,
    progressConsistency: 0,
    challengerDominance: 0,
    total: 0,
  };
}

export function evaluateRouteHealth(
  observations: RouteObservation[],
  current: RouteCandidateScore | null,
  challengerMargin: number | null,
  config: TrackingConfig
): RouteHealth {
  if (observations.length === 0 && !current) {
    return emptyRouteHealth();
  }

  const distances = observations.map((obs) => obs.distanceMeters);
  if (current) distances.push(current.distanceMeters);
  const meanDistance = average(distances);
  const distanceConsistency = clamp01(1 - meanDistance / 120);

  const headingDiffs = observations
    .map((obs) => obs.headingDifferenceDegrees)
    .filter((value): value is number => value !== null);
  const meanHeadingDiff = headingDiffs.length > 0 ? average(headingDiffs) : 45;
  const headingConsistency = clamp01(1 - meanHeadingDiff / 90);

  const trajectoryDiffs = observations
    .map((obs) => obs.trajectoryHeadingDifferenceDegrees)
    .filter((value): value is number => value !== null);
  const trajectoryConsistency =
    trajectoryDiffs.length === 0 ? 0.5 : clamp01(1 - average(trajectoryDiffs) / 90);

  const stationSequences = observations
    .map((obs) => obs.stationSequence)
    .filter((value): value is number => value !== null);
  const stationSequenceConsistency =
    stationSequences.length < 2 ? 0.5 : monotonicityRatio(stationSequences, 0);

  const topologyPairs = observations.length < 2 ? 0 : observations.length - 1;
  const connectedPairs = observations.filter((obs, index) => {
    if (index === 0) return false;
    return observationsAreTopologicallyConnected(observations[index - 1], obs);
  }).length;
  const topologyConsistency = topologyPairs === 0 ? 0.5 : connectedPairs / topologyPairs;

  const positions = observations
    .map((obs) => obs.trackPositionMeters)
    .filter((value): value is number => value !== null);
  let progressConsistency =
    positions.length < 3 ? 0.7 : monotonicityRatio(positions, config.routeProgressJitterMeters);
  if (meanDistance > 80) {
    progressConsistency *= 0.4;
  }

  const dominance = challengerMargin !== null && challengerMargin > 0
    ? clamp01(challengerMargin / Math.max(config.routeChallengerMinMargin * 2, 1))
    : 0;
  const challengerDominance = 1 - dominance;

  let total = clamp01(
    distanceConsistency * 0.34 +
      headingConsistency * 0.1 +
      trajectoryConsistency * 0.1 +
      stationSequenceConsistency * 0.1 +
      topologyConsistency * 0.08 +
      progressConsistency * 0.2 +
      challengerDominance * 0.08
  );
  if (meanDistance > 150) total = Math.min(total, 0.32);
  else if (meanDistance > 80) total = Math.min(total, 0.42);

  return {
    distanceConsistency: round2(distanceConsistency),
    headingConsistency: round2(headingConsistency),
    trajectoryConsistency: round2(trajectoryConsistency),
    stationSequenceConsistency: round2(stationSequenceConsistency),
    topologyConsistency: round2(topologyConsistency),
    progressConsistency: round2(progressConsistency),
    challengerDominance: round2(challengerDominance),
    total: round2(total),
  };
}

export function observationsAreTopologicallyConnected(
  previous: RouteObservation,
  current: RouteObservation
): boolean {
  if (previous.segmentId === current.segmentId) return true;
  if (previous.nextSegmentIds.includes(current.segmentId)) return true;
  if (previous.previousSegmentIds.includes(current.segmentId)) return true;
  if (current.nextSegmentIds.includes(previous.segmentId)) return true;
  if (current.previousSegmentIds.includes(previous.segmentId)) return true;
  return false;
}

export function headingDifferenceOrNull(
  headingDegrees: number | null | undefined,
  bearingDegrees: number
): number | null {
  if (headingDegrees === null || headingDegrees === undefined) return null;
  const forward = calculateHeadingDifference(headingDegrees, bearingDegrees);
  const backward = calculateHeadingDifference(headingDegrees, (bearingDegrees + 180) % 360);
  return Math.min(forward, backward);
}

function monotonicityRatio(values: number[], jitter: number): number {
  let forward = 0;
  let backward = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (Math.abs(delta) <= jitter) continue;
    if (delta > 0) forward++;
    else backward++;
  }
  const decided = forward + backward;
  if (decided === 0) return 0.75;
  return Math.max(forward, backward) / decided;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
