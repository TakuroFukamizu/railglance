import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample } from '../models/location';
import { RailwayLine, TrackSegment, WindowRouteScore } from '../models/railway';
import { findClosestPointOnPolyline } from '../geo/polyline';
import { calculateBearing, calculateHeadingDifference } from '../geo/heading';
import { computeTrajectory, osSpeedStopped } from '../geo/trajectory';
import { segmentsAreAdjacent } from './continuity';

export type WindowScoreableRoute = {
  routeId: string;
  line: RailwayLine;
  segments: TrackSegment[];
};

export function scoreRoutesOverWindow(
  history: LocationSample[],
  routes: WindowScoreableRoute[],
  config: TrackingConfig
): WindowRouteScore[] {
  if (history.length === 0) return [];

  const latest = history[history.length - 1];
  const trajectory = computeTrajectory(history, latest.timestampMs, config);
  const osStopped = osSpeedStopped(latest, config);
  const heading = osStopped === true || !trajectory.reliable ? null : trajectory.headingDegrees;
  const stopped = osStopped === true;

  return routes
    .map((route) => scoreOneRoute(history, route, heading, stopped, config))
    .sort((a, b) => b.totalScore - a.totalScore);
}

function scoreOneRoute(
  history: LocationSample[],
  route: WindowScoreableRoute,
  trajectoryHeading: number | null,
  stopped: boolean,
  config: TrackingConfig
): WindowRouteScore {
  const nowMs = history[history.length - 1]?.timestampMs ?? 0;
  const weights = history.map((sample) => Math.exp(-(nowMs - sample.timestampMs) / 5000));
  const projections = history.map((sample) => projectOntoRoute(sample, route.segments));
  const distances = projections.map((projection) => projection.distanceMeters);
  const meanDistance = weightedAverage(distances, weights);
  const meanDistanceScore = clamp01(1 - meanDistance / 120);

  const headingDiffs = projections
    .map((projection) => {
      if (trajectoryHeading === null) return null;
      return Math.min(
        calculateHeadingDifference(trajectoryHeading, projection.bearingDegrees),
        calculateHeadingDifference(trajectoryHeading, (projection.bearingDegrees + 180) % 360)
      );
    })
    .filter((value): value is number => value !== null);
  const headingConsistencyScore = headingDiffs.length === 0 ? 0.5 : clamp01(1 - average(headingDiffs) / 90);

  const positions = projections
    .map((projection) => projection.trackPositionMeters)
    .filter((value): value is number => value !== null);
  const progressMonotonicityScore = stopped || positions.length < 3
    ? 0.7
    : monotonicityRatio(positions, config.routeProgressJitterMeters);

  const sequences = projections
    .map((projection) => projection.stationSequence)
    .filter((value): value is number => value !== null);
  const stationSequenceScore = sequences.length < 2 ? 0.5 : monotonicityRatio(sequences, 0);

  const topologyPairs = projections.length < 2 ? 0 : projections.length - 1;
  const connectedPairs = projections.filter((projection, index) => {
    const previous = projections[index - 1]?.segment;
    const current = projection.segment;
    if (index === 0 || !previous || !current) return false;
    return previous.id === current.id || segmentsAreAdjacent(previous, current);
  }).length;
  const topologyScore = topologyPairs === 0 ? 0.5 : connectedPairs / topologyPairs;

  const totalScore =
    meanDistanceScore * 0.32 +
    headingConsistencyScore * 0.2 +
    progressMonotonicityScore * 0.22 +
    stationSequenceScore * 0.14 +
    topologyScore * 0.12;

  return {
    routeId: route.routeId,
    lineId: route.line.id,
    lineName: route.line.name,
    meanDistanceScore: round2(meanDistanceScore),
    headingConsistencyScore: round2(headingConsistencyScore),
    progressMonotonicityScore: round2(progressMonotonicityScore),
    stationSequenceScore: round2(stationSequenceScore),
    topologyScore: round2(topologyScore),
    totalScore: round2(totalScore),
  };
}

function projectOntoRoute(sample: LocationSample, segments: TrackSegment[]) {
  let best = {
    distanceMeters: Number.POSITIVE_INFINITY,
    bearingDegrees: 0,
    trackPositionMeters: null as number | null,
    stationSequence: null as number | null,
    lineId: segments[0]?.lineId ?? '',
    segment: null as TrackSegment | null,
  };

  for (const segment of segments) {
    if (segment.coordinates.length < 2) continue;
    const closest = findClosestPointOnPolyline(sample.latitude, sample.longitude, segment.coordinates);
    if (closest.distanceMeters >= best.distanceMeters) continue;
    const idx = closest.segmentIndex;
    const p1 = segment.coordinates[idx];
    const p2 = segment.coordinates[Math.min(idx + 1, segment.coordinates.length - 1)];
    best = {
      distanceMeters: closest.distanceMeters,
      bearingDegrees: calculateBearing(p1[0], p1[1], p2[0], p2[1]),
      trackPositionMeters: (segment.startOffsetMeters ?? 0) + closest.distanceAlongPolylineMeters,
      stationSequence: segment.startOffsetMeters ?? null,
      lineId: segment.lineId,
      segment,
    };
  }

  return best;
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

function weightedAverage(values: number[], weights: number[]): number {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    weighted += values[i] * (weights[i] ?? 1);
    total += weights[i] ?? 1;
  }
  return total === 0 ? 0 : weighted / total;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
