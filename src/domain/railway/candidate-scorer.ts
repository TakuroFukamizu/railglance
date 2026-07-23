import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample } from '../models/location';
import { RailwayLine, RouteCandidateScore, TrackSegment } from '../models/railway';
import { findClosestPointOnPolyline } from '../geo/polyline';
import { calculateBearing, calculateHeadingDifference } from '../geo/heading';

export function scoreCandidate(
  sample: LocationSample,
  segment: TrackSegment,
  line: RailwayLine,
  previousMatchSegmentId: string | null,
  config: TrackingConfig
): RouteCandidateScore {
  const closest = findClosestPointOnPolyline(sample.latitude, sample.longitude, segment.coordinates);
  const distance = closest.distanceMeters;

  // 1. Distance score (100 pts max, decays with distance up to search radius)
  const distRatio = Math.min(1, distance / config.routeSearchRadiusMeters);
  const distanceScore = Math.max(0, 100 * (1 - distRatio * distRatio));

  // 2. Heading score (100 pts max, compare GPS/calculated heading to track segment orientation)
  let headingScore = 50; // default neutral if heading unavailable
  let bearingDegrees = 0;

  if (segment.coordinates.length >= 2) {
    const idx = closest.segmentIndex;
    const p1 = segment.coordinates[idx];
    const p2 = segment.coordinates[Math.min(idx + 1, segment.coordinates.length - 1)];
    bearingDegrees = calculateBearing(p1[0], p1[1], p2[0], p2[1]);

    if (sample.headingDegrees !== null) {
      const headingDiffForward = calculateHeadingDifference(sample.headingDegrees, bearingDegrees);
      const headingDiffBackward = calculateHeadingDifference(
        sample.headingDegrees,
        (bearingDegrees + 180) % 360
      );
      const minDiff = Math.min(headingDiffForward, headingDiffBackward);
      headingScore = Math.max(0, 100 * (1 - minDiff / 90));
    }
  }

  // 3. Continuity score (50 pts bonus if it matches previous segment or same line)
  let continuityScore = 0;
  if (previousMatchSegmentId === segment.id) {
    continuityScore = 50;
  } else if (previousMatchSegmentId && previousMatchSegmentId.split('-')[0] === segment.lineId) {
    continuityScore = 25;
  }

  // 4. History / Accuracy weighting
  const historyScore = sample.accuracyMeters <= 20 ? 20 : sample.accuracyMeters <= 50 ? 10 : 0;

  const totalScore = Math.round((distanceScore * 0.45 + headingScore * 0.3 + continuityScore + historyScore) * 10) / 10;

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
  };
}
