import { haversineDistance, pointToSegmentDistance } from './distance';

export type ClosestPolylinePointResult = {
  distanceMeters: number;
  projectedPoint: [number, number]; // [lat, lon]
  segmentIndex: number;
  fractionInSegment: number;
  distanceAlongPolylineMeters: number;
  totalPolylineLengthMeters: number;
};

/**
 * Calculates total length in meters of a polyline coordinates array [[lat, lon], ...].
 */
export function calculatePolylineLength(coordinates: Array<[number, number]>): number {
  let total = 0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    total += haversineDistance(
      coordinates[i][0],
      coordinates[i][1],
      coordinates[i + 1][0],
      coordinates[i + 1][1]
    );
  }
  return total;
}

/**
 * Finds the closest point on a polyline to a given point (pLat, pLon).
 */
export function findClosestPointOnPolyline(
  pLat: number,
  pLon: number,
  coordinates: Array<[number, number]>
): ClosestPolylinePointResult {
  if (coordinates.length < 2) {
    const lat = coordinates[0]?.[0] ?? pLat;
    const lon = coordinates[0]?.[1] ?? pLon;
    return {
      distanceMeters: haversineDistance(pLat, pLon, lat, lon),
      projectedPoint: [lat, lon],
      segmentIndex: 0,
      fractionInSegment: 0,
      distanceAlongPolylineMeters: 0,
      totalPolylineLengthMeters: 0,
    };
  }

  let minDistance = Infinity;
  let bestResult: ClosestPolylinePointResult | null = null;

  const segmentLengths: number[] = [];
  for (let i = 0; i < coordinates.length - 1; i++) {
    const segLen = haversineDistance(
      coordinates[i][0],
      coordinates[i][1],
      coordinates[i + 1][0],
      coordinates[i + 1][1]
    );
    segmentLengths.push(segLen);
  }
  const totalLength = segmentLengths.reduce((a, b) => a + b, 0);

  let currentDistAlong = 0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = coordinates[i];
    const b = coordinates[i + 1];
    const res = pointToSegmentDistance(pLat, pLon, a[0], a[1], b[0], b[1]);

    if (res.distanceMeters < minDistance) {
      minDistance = res.distanceMeters;
      bestResult = {
        distanceMeters: res.distanceMeters,
        projectedPoint: res.projectedPoint,
        segmentIndex: i,
        fractionInSegment: res.fraction,
        distanceAlongPolylineMeters: currentDistAlong + res.fraction * segmentLengths[i],
        totalPolylineLengthMeters: totalLength,
      };
    }
    currentDistAlong += segmentLengths[i];
  }

  return bestResult!;
}
