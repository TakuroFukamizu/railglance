const EARTH_RADIUS_METERS = 6371000;

/**
 * Calculates the Haversine distance in meters between two lat/lon coordinates.
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const rLat1 = (lat1 * Math.PI) / 180;
  const rLat2 = (lat2 * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(rLat1) * Math.cos(rLat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

export type PointToSegmentResult = {
  distanceMeters: number;
  projectedPoint: [number, number]; // [lat, lon]
  fraction: number; // 0.0 to 1.0 along line segment AB
};

/**
 * Calculates the shortest distance in meters from a point P to a line segment AB,
 * along with the projected point and fraction along AB.
 */
export function pointToSegmentDistance(
  pLat: number,
  pLon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): PointToSegmentResult {
  const abDist = haversineDistance(aLat, aLon, bLat, bLon);
  if (abDist < 1e-6) {
    return {
      distanceMeters: haversineDistance(pLat, pLon, aLat, aLon),
      projectedPoint: [aLat, aLon],
      fraction: 0,
    };
  }

  // Convert to local Cartesian approximation around A
  const cosLat = Math.cos((aLat * Math.PI) / 180);
  const degToMetersLat = 111139;
  const degToMetersLon = 111139 * cosLat;

  const px = (pLon - aLon) * degToMetersLon;
  const py = (pLat - aLat) * degToMetersLat;
  const bx = (bLon - aLon) * degToMetersLon;
  const by = (bLat - aLat) * degToMetersLat;

  const segmentLenSq = bx * bx + by * by;
  let fraction = (px * bx + py * by) / segmentLenSq;
  fraction = Math.max(0, Math.min(1, fraction));

  const projX = fraction * bx;
  const projY = fraction * by;

  const projLon = aLon + projX / degToMetersLon;
  const projLat = aLat + projY / degToMetersLat;

  const distanceMeters = haversineDistance(pLat, pLon, projLat, projLon);

  return {
    distanceMeters,
    projectedPoint: [projLat, projLon],
    fraction,
  };
}
