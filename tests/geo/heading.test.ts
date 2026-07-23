import { describe, it, expect } from 'vitest';
import { calculateBearing, calculateHeadingDifference } from '../../src/domain/geo/heading';

describe('heading.ts', () => {
  it('calculates initial bearing from South to North as ~0 degrees', () => {
    const bearing = calculateBearing(35.0, 139.0, 36.0, 139.0);
    expect(Math.round(bearing)).toBe(0);
  });

  it('calculates initial bearing from West to East as ~90 degrees', () => {
    const bearing = calculateBearing(35.0, 139.0, 35.0, 140.0);
    expect(Math.round(bearing)).toBe(90);
  });

  it('calculates heading difference minimal angle between two headings', () => {
    expect(calculateHeadingDifference(10, 350)).toBe(20);
    expect(calculateHeadingDifference(90, 180)).toBe(90);
    expect(calculateHeadingDifference(0, 180)).toBe(180);
  });
});
