import { TrackSegment } from '../models/railway';
import { pointToSegmentDistance, haversineDistance } from '../geo/distance';

export type RouteProjectionResult = {
  segment: TrackSegment;
  trackPositionMeters: number;
  distanceToPolylineMeters: number;
  projectedPoint: [number, number];
};

export class RoutePositionProjector {
  /**
   * Projects a 2D GPS point (lat, lon) onto a 1D track segment and returns cumulative route distance.
   */
  public projectPointToSegment(
    lat: number,
    lon: number,
    segment: TrackSegment
  ): RouteProjectionResult {
    const coords = segment.coordinates;
    const startOffset = segment.startOffsetMeters ?? 0;

    if (coords.length < 2) {
      return {
        segment,
        trackPositionMeters: startOffset,
        distanceToPolylineMeters: haversineDistance(lat, lon, coords[0][0], coords[0][1]),
        projectedPoint: coords[0] || [lat, lon],
      };
    }

    let minDistance = Infinity;
    let bestProjectedPoint: [number, number] = coords[0];
    let distanceAlongSeg = 0;
    let currentSegAccumulator = 0;

    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      const subLen = haversineDistance(a[0], a[1], b[0], b[1]);

      const res = pointToSegmentDistance(lat, lon, a[0], a[1], b[0], b[1]);
      if (res.distanceMeters < minDistance) {
        minDistance = res.distanceMeters;
        bestProjectedPoint = res.projectedPoint;
        distanceAlongSeg = currentSegAccumulator + subLen * res.fraction;
      }
      currentSegAccumulator += subLen;
    }

    return {
      segment,
      trackPositionMeters: Math.round(startOffset + distanceAlongSeg),
      distanceToPolylineMeters: Math.round(minDistance),
      projectedPoint: bestProjectedPoint,
    };
  }

  /**
   * Converts 1D track position (meters) back to 2D GPS point (lat, lon) along a segment.
   */
  public convertTrackPositionToPoint(
    trackPositionMeters: number,
    segment: TrackSegment
  ): [number, number] {
    const startOffset = segment.startOffsetMeters ?? 0;
    const offsetInSeg = Math.max(0, trackPositionMeters - startOffset);
    const coords = segment.coordinates;

    if (coords.length < 2) return coords[0];

    let accumulated = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      const subLen = haversineDistance(a[0], a[1], b[0], b[1]);

      if (accumulated + subLen >= offsetInSeg && subLen > 0) {
        const fraction = (offsetInSeg - accumulated) / subLen;
        const lat = a[0] + (b[0] - a[0]) * fraction;
        const lon = a[1] + (b[1] - a[1]) * fraction;
        return [lat, lon];
      }
      accumulated += subLen;
    }

    return coords[coords.length - 1];
  }
}
