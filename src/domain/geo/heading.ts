/**
 * Calculates initial bearing in degrees (0-360) from Point A (lat1, lon1) to Point B (lat2, lon2).
 */
export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const theta = Math.atan2(y, x);
  const bearing = ((theta * 180) / Math.PI + 360) % 360;
  return bearing;
}

/**
 * Calculates the minimal absolute angle difference in degrees (0-180) between two bearings.
 */
export function calculateHeadingDifference(h1: number, h2: number): number {
  const diff = Math.abs((h1 - h2) % 360);
  return diff > 180 ? 360 - diff : diff;
}
