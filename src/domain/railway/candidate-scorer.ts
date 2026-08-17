import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample } from '../models/location';
import {
  ContinuityKind,
  RailwayLine,
  RouteCandidateScore,
  RouteLockState,
  TrackSegment,
} from '../models/railway';
import { findClosestPointOnPolyline } from '../geo/polyline';
import { calculateBearing, calculateHeadingDifference } from '../geo/heading';
import { classifyContinuity, continuityBonus } from './continuity';

export type ScoreCandidateInput = {
  sample: LocationSample;
  segment: TrackSegment;
  line: RailwayLine;
  previousSegment: TrackSegment | null;
  nearbySegments: TrackSegment[];
  lockState: RouteLockState;
  effectiveHeadingDegrees: number | null;
  config: TrackingConfig;
};

export function looksLikeShinkansen(line: RailwayLine): boolean {
  const name = `${line.name} ${line.shortName ?? ''}`;
  return name.includes('新幹線');
}

export function scoreCandidate(input: ScoreCandidateInput): RouteCandidateScore {
  const { sample, segment, line, previousSegment, nearbySegments, lockState, effectiveHeadingDegrees, config } =
    input;

  const closest = findClosestPointOnPolyline(sample.latitude, sample.longitude, segment.coordinates);
  const distance = closest.distanceMeters;
  const startOffset = segment.startOffsetMeters ?? 0;
  const trackPositionMeters = startOffset + closest.distanceAlongPolylineMeters;

  const accuracyFloor = Math.max(sample.accuracyMeters, config.routeMinimumAccuracyMeters);
  const normalizedDistance = distance / accuracyFloor;

  // 1. Distance score (40 pts max), softened by GPS-accuracy-normalized distance.
  const distRatio = Math.min(1, distance / config.routeSearchRadiusMeters);
  let distanceScore = Math.max(0, 40 * (1 - distRatio * distRatio));
  if (normalizedDistance > 1) {
    distanceScore *= 1 / (1 + (normalizedDistance - 1) * 0.45);
  }

  // 2. Heading score (30 pts max). Trajectory heading is preferred by the caller.
  let headingScore = 15;
  let bearingDegrees = 0;

  if (segment.coordinates.length >= 2) {
    const idx = closest.segmentIndex;
    const p1 = segment.coordinates[idx];
    const p2 = segment.coordinates[Math.min(idx + 1, segment.coordinates.length - 1)];
    bearingDegrees = calculateBearing(p1[0], p1[1], p2[0], p2[1]);

    if (effectiveHeadingDegrees !== null) {
      const headingDiffForward = calculateHeadingDifference(effectiveHeadingDegrees, bearingDegrees);
      const headingDiffBackward = calculateHeadingDifference(
        effectiveHeadingDegrees,
        (bearingDegrees + 180) % 360
      );
      const minDiff = Math.min(headingDiffForward, headingDiffBackward);
      headingScore = Math.max(0, 30 * (1 - minDiff / 90));
    }
  }

  // 3. Topology continuity (up to 20 pts, scaled by lock state).
  const continuityKind: ContinuityKind = classifyContinuity(previousSegment, segment, nearbySegments);
  const continuityScore = continuityBonus(continuityKind, lockState, config);

  // 4. Accuracy / history weighting (10 pts max).
  const historyScore = sample.accuracyMeters <= 20 ? 10 : sample.accuracyMeters <= 50 ? 5 : 0;

  // 5. Asymmetric speed: fast travel can reject conventional lines. Slow travel never rejects Shinkansen.
  let speedPenalty = 0;
  if (sample.speedMps !== null && sample.speedMps > 0) {
    const speedKmh = sample.speedMps * 3.6;
    if (speedKmh > config.routeConventionalMaxSpeedKmh && !looksLikeShinkansen(line)) {
      speedPenalty = config.routeImpossibleSpeedPenalty;
    }
  }

  const totalScore =
    Math.round((distanceScore + headingScore + continuityScore + historyScore - speedPenalty) * 10) / 10;

  return {
    segment,
    line,
    distanceMeters: Math.round(distance * 10) / 10,
    distanceScore: Math.round(distanceScore * 10) / 10,
    headingScore: Math.round(headingScore * 10) / 10,
    continuityScore,
    historyScore,
    totalScore,
    projectedPoint: closest.projectedPoint,
    bearingDegrees: Math.round(bearingDegrees * 10) / 10,
    normalizedDistance: Math.round(normalizedDistance * 100) / 100,
    continuityKind,
    effectiveHeadingDegrees,
    trackPositionMeters: Math.round(trackPositionMeters),
  };
}

