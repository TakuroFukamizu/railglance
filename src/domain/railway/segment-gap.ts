import { haversineDistance } from '../geo/distance';
import { ClosestPolylinePointResult, findClosestPointOnPolyline } from '../geo/polyline';
import { TrackSegment } from '../models/railway';
import { segmentsAreAdjacent } from './continuity';

const METERS_PER_DEGREE_LAT = 111139;
/** Baseline length used to estimate the direction a polyline leaves its end vertex. */
const END_TANGENT_BASELINE_METERS = 50;

export type EndGapProjection = {
  /** Offset from the track as it plausibly continues through the hole. */
  distanceMeters: number;
  /** Track position extrapolated beyond the segment end. */
  trackPositionMeters: number;
};

export type EndGapOptions = {
  /** Longest hole bridged past the segment end (TrackingConfig.routeSegmentEndOverrunMeters). */
  maxOverrunMeters: number;
  /** A segment within this distance of the sample covers it. */
  coverToleranceMeters: number;
  /**
   * A covering segment that does not continue this track cancels the projection only when
   * it is closer to the sample than the projection by more than this. Parallel lines 20 m
   * apart swap places under GPS noise, and a per-fix flip would drop a correct lock in a
   * hole back to its raw end-vertex distance.
   */
  otherCoverMarginMeters: number;
  /** Far-side ends closer than this are the same junction (routeSegmentGapMinBridgeMeters). */
  minBridgeMeters: number;
  /** Maximum turn between end tangent, bridge and far-side segment (routeSegmentGapMaxTurnDegrees). */
  maxTurnDegrees: number;
};

type Vec = { x: number; y: number };

/**
 * MLIT segments end at junctions rather than at platforms, so a train that is still on
 * a segment's track regularly runs a few hundred metres past the polyline end (station
 * holes of 200-500 m at 田端, 品川, 有楽町, 御茶ノ水, 両国...). Measured against the end
 * vertex, the distance grows as if the train had left the line, while a parallel line
 * with continuous geometry looks like the better match.
 *
 * When the sample is beyond an end of `segment`, this estimates the offset from where the
 * track plausibly continues: the extrapolated end tangent, or a straight bridge to the
 * aligned end of another segment on the far side of the hole. Returns null when the sample
 * is not beyond an end, the hole is longer than `options.maxOverrunMeters`, a segment attached
 * to this end already covers the sample (the data continues, so there is no hole), or any
 * other segment covers the sample clearly more closely than the projection would.
 */
export function projectAcrossEndGap(
  sample: { latitude: number; longitude: number },
  segment: TrackSegment,
  closest: ClosestPolylinePointResult,
  nearbySegments: TrackSegment[],
  options: EndGapOptions
): EndGapProjection | null {
  const { maxOverrunMeters, coverToleranceMeters, otherCoverMarginMeters, minBridgeMeters, maxTurnDegrees } = options;
  const coordinates = segment.coordinates;
  const n = coordinates.length;
  if (n < 2) return null;

  let end: 'first' | 'last';
  if (isClampedTo('last', closest, n)) end = 'last';
  else if (isClampedTo('first', closest, n)) end = 'first';
  else return null;

  const step = end === 'last' ? -1 : 1;
  const endIndex = end === 'last' ? n - 1 : 0;
  const endPoint = coordinates[endIndex];
  const toLocal = localFrame(endPoint);

  let baseIndex = endIndex + step;
  while (
    baseIndex + step >= 0 &&
    baseIndex + step < n &&
    haversineDistance(endPoint[0], endPoint[1], coordinates[baseIndex][0], coordinates[baseIndex][1]) <
      END_TANGENT_BASELINE_METERS
  ) {
    baseIndex += step;
  }
  const tangent = normalize(negate(toLocal(coordinates[baseIndex])));
  if (!tangent) return null;

  const p = toLocal([sample.latitude, sample.longitude]);
  const along = dot(p, tangent);
  if (along <= 0) return null;

  let best = Number.POSITIVE_INFINITY;
  // Closest other segment that carries the sample on its own geometry (not at an end).
  let otherCoverMeters = Number.POSITIVE_INFINITY;
  // Where the data resumes on the far side bounds how long the hole can be.
  let farthestResumeMeters: number | null = null;

  for (const other of nearbySegments) {
    if (other.id === segment.id || other.coordinates.length < 2) continue;
    const oc = other.coordinates;
    // Does `other` pick the track up again, either right at this end or across the hole?
    let continuesTrack = segmentsAreAdjacent(segment, other);
    for (const [far, inner] of [
      [oc[0], oc[1]],
      [oc[oc.length - 1], oc[oc.length - 2]],
    ] as const) {
      const farVec = toLocal(far);
      const farLength = Math.hypot(farVec.x, farVec.y);
      if (farLength > maxOverrunMeters) continue;
      const innerVec = toLocal(inner);
      const continuation = normalize({ x: innerVec.x - farVec.x, y: innerVec.y - farVec.y });
      if (!continuation) continue;
      if (farLength < minBridgeMeters) {
        if (angleBetween(continuation, tangent) <= maxTurnDegrees) continuesTrack = true;
        continue;
      }
      const bridge = { x: farVec.x / farLength, y: farVec.y / farLength };
      if (angleBetween(bridge, tangent) > maxTurnDegrees) continue;
      if (angleBetween(bridge, continuation) > maxTurnDegrees) continue;
      farthestResumeMeters = Math.max(farthestResumeMeters ?? 0, farLength);
      // A segment starting across the hole does not end it: parallel lines of other
      // operators (京急 at 品川, the bundled Shinkansen at 東京) start there too.
      const fraction = dot(p, bridge) / farLength;
      if (fraction <= 0 || fraction > 1) continue;
      best = Math.min(best, Math.abs(cross(p, bridge)));
    }

    const otherClosest = findClosestPointOnPolyline(sample.latitude, sample.longitude, oc);
    const clamped = isClampedTo('first', otherClosest, oc.length) || isClampedTo('last', otherClosest, oc.length);
    if (clamped || otherClosest.distanceMeters > coverToleranceMeters) continue;
    // The data resumes on `other` and the sample is on it: this end is not a hole any more.
    if (continuesTrack) return null;
    otherCoverMeters = Math.min(otherCoverMeters, otherClosest.distanceMeters);
  }

  const tangentBudget = farthestResumeMeters === null ? maxOverrunMeters : farthestResumeMeters;
  if (along <= tangentBudget) best = Math.min(best, Math.abs(cross(p, tangent)));

  if (!Number.isFinite(best)) return null;
  // Another line's continuous track (京急 at 品川 after a transfer, or the right line
  // under a biased trace) explains the sample better than the guessed continuation
  // through the hole: do not defend this segment with the guess.
  if (otherCoverMeters + otherCoverMarginMeters < best) return null;

  const startOffset = segment.startOffsetMeters ?? 0;
  return {
    distanceMeters: best,
    trackPositionMeters:
      end === 'last' ? startOffset + closest.totalPolylineLengthMeters + along : startOffset - along,
  };
}

function isClampedTo(end: 'first' | 'last', closest: ClosestPolylinePointResult, vertexCount: number): boolean {
  return end === 'last'
    ? closest.segmentIndex === vertexCount - 2 && closest.fractionInSegment >= 1
    : closest.segmentIndex === 0 && closest.fractionInSegment <= 0;
}

function localFrame(origin: [number, number]): (point: [number, number]) => Vec {
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return (point) => ({
    x: (point[1] - origin[1]) * metersPerDegreeLon,
    y: (point[0] - origin[0]) * METERS_PER_DEGREE_LAT,
  });
}

function normalize(v: Vec): Vec | null {
  const length = Math.hypot(v.x, v.y);
  return length < 1 ? null : { x: v.x / length, y: v.y / length };
}

function negate(v: Vec): Vec {
  return { x: -v.x, y: -v.y };
}

function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y;
}

function cross(a: Vec, b: Vec): number {
  return a.x * b.y - a.y * b.x;
}

function angleBetween(a: Vec, b: Vec): number {
  return (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
}
