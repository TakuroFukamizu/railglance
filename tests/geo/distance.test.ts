import { describe, it, expect } from 'vitest';
import { haversineDistance, pointToSegmentDistance } from '../../src/domain/geo/distance';

describe('distance.ts', () => {
  it('calculates Haversine distance between Ebina and Zama stations accurately', () => {
    // Ebina: 35.4526, 139.3900
    // Zama:  35.4806, 139.4005
    const dist = haversineDistance(35.4526, 139.3900, 35.4806, 139.4005);
    expect(dist).toBeGreaterThan(3000);
    expect(dist).toBeLessThan(3500);
  });

  it('calculates shortest distance from point to line segment correctly', () => {
    // Segment A (0,0) to B (0, 1)
    // Point P (0.5, 0.5)
    const res = pointToSegmentDistance(0.5, 0, 0, 0, 0, 1);
    expect(res.fraction).toBe(0);
    expect(res.distanceMeters).toBeGreaterThan(0);
  });
});
