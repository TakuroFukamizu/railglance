import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { LocationSample } from '../../src/domain/models/location';
import { RailwayLine, TrackSegment } from '../../src/domain/models/railway';
import { scoreRoutesOverWindow } from '../../src/domain/railway/window-scorer';

const LINE_A: RailwayLine = { id: 'line-a', operatorId: 'op', name: '在来線A' };
const LINE_B: RailwayLine = { id: 'line-b', operatorId: 'op', name: '在来線B' };
const METERS_PER_DEGREE_LON = 111139 * Math.cos((35 * Math.PI) / 180);

const onTrack: TrackSegment = {
  id: 'a-1',
  lineId: LINE_A.id,
  routeId: 'route-a',
  fromStationId: 'a-from',
  toStationId: 'a-to',
  coordinates: [
    [35.0, 139.0],
    [35.1, 139.0],
  ],
  startOffsetMeters: 0,
};

// A parallel sub-line sharing the corridor, 20 m east.
const parallel: TrackSegment = {
  ...onTrack,
  id: 'b-1',
  lineId: LINE_B.id,
  routeId: 'route-b',
  fromStationId: 'b-from',
  toStationId: 'b-to',
  coordinates: [
    [35.0, 139.0 + 20 / METERS_PER_DEGREE_LON],
    [35.1, 139.0 + 20 / METERS_PER_DEGREE_LON],
  ],
};

function history(accuracyMeters: number): LocationSample[] {
  return Array.from({ length: 8 }, (_, i) => ({
    latitude: 35.02 + i * 0.0002,
    longitude: 139.0,
    accuracyMeters,
    speedMps: 20,
    headingDegrees: 0,
    timestampMs: 10_000 + i * 1000,
  }));
}

function margin(accuracyMeters: number) {
  const scores = scoreRoutesOverWindow(
    history(accuracyMeters),
    [
      { routeId: 'route-a', line: LINE_A, segments: [onTrack] },
      { routeId: 'route-b', line: LINE_B, segments: [parallel] },
    ],
    DEFAULT_TRACKING_CONFIG
  );
  const a = scores.find((score) => score.routeId === 'route-a')!;
  const b = scores.find((score) => score.routeId === 'route-b')!;
  return { a, b, margin: a.totalScore - b.totalScore };
}

describe('window distance falloff under degraded GPS', () => {
  it('still separates a parallel line 20 m away when accuracy is 70 m', () => {
    const { a, b, margin: windowMargin } = margin(70);
    expect(a.meanDistanceScore).toBe(1);
    // Never more lenient than the linear falloff (20 m of 120 m).
    expect(b.meanDistanceScore).toBeLessThanOrEqual(0.84);
    // The reacquire path needs a window margin of at least 0.05 to act on the window leader.
    expect(windowMargin).toBeGreaterThanOrEqual(0.05);
  });

  it('keeps the sharper accuracy-scaled falloff under open sky', () => {
    const { b, margin: windowMargin } = margin(10);
    expect(b.meanDistanceScore).toBeLessThan(0.75);
    expect(windowMargin).toBeGreaterThan(margin(70).margin);
  });
});
