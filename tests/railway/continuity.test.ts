import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { TrackSegment } from '../../src/domain/models/railway';
import { classifyContinuity, continuityBonus } from '../../src/domain/railway/continuity';

const base: TrackSegment = {
  id: 'a-1',
  lineId: 'line-a',
  routeId: 'route-a',
  fromStationId: 's1',
  toStationId: 's2',
  coordinates: [[35, 139], [35.1, 139]],
  nextSegmentIds: ['a-2'],
};

const adjacent: TrackSegment = {
  id: 'a-2',
  lineId: 'line-a',
  routeId: 'route-a',
  fromStationId: 's2',
  toStationId: 's3',
  coordinates: [[35.1, 139], [35.2, 139]],
  previousSegmentIds: ['a-1'],
};

const disconnectedSameLine: TrackSegment = {
  id: 'a-9',
  lineId: 'line-a',
  routeId: 'route-a-other',
  fromStationId: 's20',
  toStationId: 's21',
  coordinates: [[36, 140], [36.1, 140]],
};

const otherLine: TrackSegment = {
  id: 'b-1',
  lineId: 'line-b',
  routeId: 'route-b',
  fromStationId: 'x',
  toStationId: 'y',
  coordinates: [[35, 139.1], [35.1, 139.1]],
};

describe('topology continuity', () => {
  it('ranks same segment above adjacent, reachable, disconnected, then unrelated', () => {
    expect(classifyContinuity(base, base, [base])).toBe('same-segment');
    expect(classifyContinuity(base, adjacent, [base, adjacent])).toBe('adjacent-segment');
    expect(classifyContinuity(base, disconnectedSameLine, [base, disconnectedSameLine])).toBe('same-line-disconnected');
    expect(classifyContinuity(base, otherLine, [base, otherLine])).toBe('unrelated');
  });

  it('does not treat different lines that share a station as reachable when routeId is missing', () => {
    const sobu: TrackSegment = {
      id: 'sobu-akihabara',
      lineId: 'chuo-sobu',
      fromStationId: 'akihabara',
      toStationId: 'kanda',
      coordinates: [[35.698, 139.773], [35.691, 139.771]],
    };
    const shinkansen: TrackSegment = {
      id: 'tohoku-tokyo-ueno',
      lineId: 'tohoku-shinkansen',
      fromStationId: 'tokyo',
      toStationId: 'akihabara',
      coordinates: [[35.681, 139.767], [35.698, 139.773]],
    };

    expect(classifyContinuity(sobu, shinkansen, [sobu, shinkansen])).toBe('unrelated');
  });

  it('does not give a high bonus to a disconnected segment on the same line', () => {
    const disconnected = continuityBonus('same-line-disconnected', 'LOCKED', DEFAULT_TRACKING_CONFIG);
    const adjacentBonus = continuityBonus('adjacent-segment', 'LOCKED', DEFAULT_TRACKING_CONFIG);
    expect(disconnected).toBe(2);
    expect(disconnected).toBeLessThan(adjacentBonus / 2);
  });
});
