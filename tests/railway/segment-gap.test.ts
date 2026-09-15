import { describe, expect, it } from 'vitest';
import { findClosestPointOnPolyline } from '../../src/domain/geo/polyline';
import { TrackSegment } from '../../src/domain/models/railway';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { projectAcrossEndGap } from '../../src/domain/railway/segment-gap';

const ORIGIN_LAT = 35.0;
const ORIGIN_LON = 139.0;
const METERS_PER_DEGREE_LAT = 111139;
const METERS_PER_DEGREE_LON = METERS_PER_DEGREE_LAT * Math.cos((ORIGIN_LAT * Math.PI) / 180);
const MAX_OVERRUN_M = 600;
const COVER_TOLERANCE_M = 30;
const OTHER_COVER_MARGIN_M = 15;

/** [lat, lon] of a point `eastM` east and `northM` north of the origin. */
function at(eastM: number, northM: number): [number, number] {
  return [ORIGIN_LAT + northM / METERS_PER_DEGREE_LAT, ORIGIN_LON + eastM / METERS_PER_DEGREE_LON];
}

function segment(id: string, points: Array<[number, number]>, extras: Partial<TrackSegment> = {}): TrackSegment {
  return {
    id,
    lineId: `line-${id}`,
    fromStationId: `${id}-from`,
    toStationId: `${id}-to`,
    coordinates: points.map(([east, north]) => at(east, north)),
    startOffsetMeters: 0,
    ...extras,
  };
}

function project(eastM: number, northM: number, seg: TrackSegment, nearby: TrackSegment[]) {
  const [latitude, longitude] = at(eastM, northM);
  const closest = findClosestPointOnPolyline(latitude, longitude, seg.coordinates);
  return {
    raw: closest.distanceMeters,
    gap: projectAcrossEndGap({ latitude, longitude }, seg, closest, nearby, {
      maxOverrunMeters: MAX_OVERRUN_M,
      coverToleranceMeters: COVER_TOLERANCE_M,
      otherCoverMarginMeters: OTHER_COVER_MARGIN_M,
      minBridgeMeters: DEFAULT_TRACKING_CONFIG.routeSegmentGapMinBridgeMeters,
      maxTurnDegrees: DEFAULT_TRACKING_CONFIG.routeSegmentGapMaxTurnDegrees,
    }),
  };
}

// The locked segment runs 1 km north and ends at a junction short of the platform.
const locked = segment('locked', [
  [0, 0],
  [0, 1000],
]);

describe('projectAcrossEndGap', () => {
  it('returns null while the sample is still alongside the segment', () => {
    expect(project(5, 500, locked, [locked]).gap).toBeNull();
  });

  it('bridges an aligned hole to the segment that resumes the track on the far side', () => {
    const farSide = segment('far', [
      [0, 1300],
      [0, 2300],
    ]);
    const { raw, gap } = project(5, 1150, locked, [locked, farSide]);

    expect(raw).toBeGreaterThan(140);
    expect(gap).not.toBeNull();
    expect(gap!.distanceMeters).toBeCloseTo(5, 0);
    expect(gap!.trackPositionMeters).toBeGreaterThan(1145);
    expect(gap!.trackPositionMeters).toBeLessThan(1155);
  });

  it('does not bridge to a far-side segment more than 45 degrees off the end tangent', () => {
    // The far side starts ~58 degrees east of the track direction.
    const misaligned = segment('misaligned', [
      [400, 1250],
      [400, 2250],
    ]);
    // The sample lies on the straight line towards the misaligned start.
    const { gap } = project(200, 1125, locked, [locked, misaligned]);

    // Only the extrapolated tangent counts: the offset stays ~200 m, not ~0 m.
    expect(gap).not.toBeNull();
    expect(gap!.distanceMeters).toBeGreaterThan(190);
  });

  it('rejects a bridge more than 45 degrees off the end tangent even when the far side runs along the bridge', () => {
    // Starts ~58 degrees east of the track direction and keeps heading that way, so only
    // the bridge-vs-tangent check can reject it.
    const alongBridge = segment('along-bridge', [
      [400, 1250],
      [800, 1500],
    ]);
    const { gap } = project(200, 1125, locked, [locked, alongBridge]);

    expect(gap).not.toBeNull();
    expect(gap!.distanceMeters).toBeGreaterThan(190);
  });

  it('does not let a crossing segment that starts straight ahead bound the hole', () => {
    // Starts on the extrapolated track 300 m past the end but runs east, so only the
    // bridge-vs-continuation check rejects it. Were it accepted, the tangent would only
    // be trusted up to 300 m and a sample 450 m past the end would lose its projection.
    const crossing = segment('crossing', [
      [0, 1300],
      [1000, 1300],
    ]);
    const { gap } = project(5, 1450, locked, [locked, crossing]);

    expect(gap).not.toBeNull();
    expect(gap!.distanceMeters).toBeCloseTo(5, 0);
  });

  it('does not defend the segment when another line carries the sample past the end (transfer)', () => {
    // Another operator's line starts inside the hole and runs on 25 m east of where this
    // track would continue: a train on it is not in this segment's station hole.
    const farSide = segment('far', [
      [0, 1300],
      [0, 2300],
    ]);
    const otherLine = segment('other-line', [
      [25, 1020],
      [25, 2000],
    ]);
    expect(project(25, 1150, locked, [locked, farSide, otherLine]).gap).toBeNull();
    // A wrong lock under a biased trace: the fixes sit on the other line 60 m off the
    // extrapolated track, so the projection must not keep this segment's distance small.
    const biasedOther = segment('biased-other', [
      [60, 600],
      [60, 2000],
    ]);
    expect(project(58, 1100, locked, [locked, biasedOther]).gap).toBeNull();
  });

  it('keeps the projection when a parallel line is only marginally closer under noise', () => {
    const farSide = segment('far', [
      [0, 1300],
      [0, 2300],
    ]);
    const parallel = segment('parallel', [
      [25, 500],
      [25, 2000],
    ]);
    // 14 m off the extrapolated track, 11 m from the parallel line: not a clear win for it.
    const { gap } = project(14, 1150, locked, [locked, farSide, parallel]);
    expect(gap).not.toBeNull();
    expect(gap!.distanceMeters).toBeCloseTo(14, 0);
  });

  it('does not bridge a hole longer than the overrun limit', () => {
    const tooFar = segment('too-far', [
      [0, 1800],
      [0, 2800],
    ]);
    expect(project(5, 1700, locked, [locked, tooFar]).gap).toBeNull();
  });

  it('stops projecting once a segment continuing this end covers the sample', () => {
    // An attached segment bends 37 degrees east right at the junction: there is no hole.
    const continuing = segment('continuing', [
      [0, 1000],
      [300, 1400],
    ]);
    const lockedWithNext = { ...locked, nextSegmentIds: ['continuing'] };
    expect(project(150, 1200, lockedWithNext, [lockedWithNext, continuing]).gap).toBeNull();
  });

  it('never reports a smaller offset than a track without the hole would', () => {
    const farSide = segment('far', [
      [0, 1300],
      [0, 2300],
    ]);
    const continuousTrack = [at(0, 0), at(0, 2300)];

    for (const [east, north] of [
      [0, 1050],
      [20, 1100],
      [-35, 1150],
      [12, 1280],
    ]) {
      const { gap } = project(east, north, locked, [locked, farSide]);
      const [latitude, longitude] = at(east, north);
      const real = findClosestPointOnPolyline(latitude, longitude, continuousTrack).distanceMeters;

      expect(gap).not.toBeNull();
      expect(gap!.distanceMeters).toBeGreaterThanOrEqual(real - 1);
      expect(gap!.distanceMeters).toBeLessThanOrEqual(real + 1);
    }
  });

  it('stops projecting past the point where the far-side segment resumes the track', () => {
    const farSide = segment('far', [
      [0, 1300],
      [0, 2300],
    ]);
    // 150 m beyond the far-side start the far segment itself scores the sample.
    expect(project(-8, 1450, locked, [locked, farSide]).gap).toBeNull();
  });
});
