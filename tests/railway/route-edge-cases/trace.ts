import { haversineDistance } from '../../../src/domain/geo/distance';
import { calculateBearing } from '../../../src/domain/geo/heading';
import { findClosestPointOnPolyline } from '../../../src/domain/geo/polyline';
import { LocationSample } from '../../../src/domain/models/location';
import { FixtureRailwayDb } from './fixture-db';

export type LatLon = [number, number];

/** A fixture segment id (oriented automatically) or an explicit [lat, lon] used to bridge data gaps. */
export type PathItem = string | LatLon;

export type GpsQuality = {
  accuracyMeters: [min: number, max: number];
  /** 1-sigma cross-track error of the reported position. */
  noiseSigmaMeters: number;
  /** No fix reaches the app at all (deep tunnel): time passes, nothing is emitted. */
  dropFixes?: boolean;
  /** The device reports a position but no speed or heading (cold reacquisition). */
  nullSpeedHeading?: boolean;
};

export const OPEN_SKY_GPS: GpsQuality = { accuracyMeters: [8, 15], noiseSigmaMeters: 6 };

/** One stretch of track between two stops (or pass-through points) with its expected line. */
export type TraceRun = {
  label: string;
  /** Ridden in order. Stored segment direction does not matter; each is oriented to continue the path. */
  path: PathItem[];
  maxSpeedKmh: number;
  /** Line ids that count as a correct answer while riding this run. */
  accept: string[];
  /** Station stop at the end of the run. Omit to keep running into the next run. */
  dwellAtEndS?: number;
  gps?: GpsQuality;
};

export type TracePoint = {
  sample: LocationSample;
  runIndex: number;
  phase: 'initial-dwell' | 'run' | 'dwell';
  /** Seconds since the current run started moving (dwell ticks keep counting). */
  secondsIntoRun: number;
};

/** Wall clock a trace starts at, whether or not its first run emits any fix. */
export const TRACE_START_TIMESTAMP_MS = 1_000;

const ACCELERATION_MPS2 = 0.7;
const MIN_MOVING_SPEED_MPS = 1.5;

/** mulberry32: small, seedable and stable across Node versions. */
function createRandom(seedText: string) {
  let seed = 0;
  for (const char of seedText) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) | 0;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = () => {
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, gaussian };
}

function distance(a: LatLon, b: LatLon): number {
  return haversineDistance(a[0], a[1], b[0], b[1]);
}

/** Chains segment polylines, flipping each one so it starts at the end closest to where the path currently is. */
export function buildRunPolyline(
  db: FixtureRailwayDb,
  items: PathItem[],
  previousEnd: LatLon | null,
  /** First item of the following run; orients a leading segment when there is nothing before it. */
  nextRunStart: PathItem | null = null
): LatLon[] {
  const path: LatLon[] = [];
  const endsOf = (item: PathItem): LatLon[] => {
    if (typeof item !== 'string') return [item];
    const coordinates = db.segment(item).coordinates;
    return [coordinates[0], coordinates[coordinates.length - 1]];
  };
  items.forEach((item, index) => {
    if (typeof item !== 'string') {
      path.push(item);
      return;
    }
    const coordinates = db.segment(item).coordinates.map(([lat, lon]) => [lat, lon] as LatLon);
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    const cursor = path[path.length - 1] ?? previousEnd;
    let flip: boolean;
    if (cursor) {
      flip = distance(cursor, last) < distance(cursor, first);
    } else if (items.length > index + 1 || nextRunStart !== null) {
      const nextEnds = endsOf(items[index + 1] ?? nextRunStart!);
      const nearestToNext = (point: LatLon) => Math.min(...nextEnds.map((end) => distance(point, end)));
      flip = nearestToNext(first) < nearestToNext(last);
    } else {
      flip = false;
    }
    // Gaps between segments (common in the MLIT data at junctions) are bridged by the straight join.
    path.push(...(flip ? [...coordinates].reverse() : coordinates));
  });
  if (previousEnd && distance(previousEnd, path[0]) > 1) path.unshift(previousEnd);
  for (let i = 1; i < path.length; i++) {
    const gap = distance(path[i - 1], path[i]);
    if (gap > MAX_BRIDGE_METERS) {
      throw new Error(`Trace path jumps ${Math.round(gap)} m near [${path[i]}]; check the run's segment order`);
    }
  }
  return path;
}

/** Longest straight join accepted between path items (the MLIT gap at 御殿山→大崎 is ~1 km). */
const MAX_BRIDGE_METERS = 1500;
const STATION_SNAP_METERS = 50;

/**
 * Moves a run's first or last point onto the platform: the polyline usually ends at a
 * junction hundreds of metres away. When the platform is beside the path rather than
 * past its end, the path is cut there instead of extended, so the train never doubles
 * back over track it already covered.
 */
function snapToStation(db: FixtureRailwayDb, item: PathItem, path: LatLon[], side: 'start' | 'end'): LatLon[] {
  const edge = side === 'end' ? path[path.length - 1] : path[0];
  const station = nearestSegmentStation(db, item, edge);
  if (!station || path.length < 2) return path;

  const closest = findClosestPointOnPolyline(station[0], station[1], path);
  const total = closest.totalPolylineLengthMeters;
  const along = closest.distanceAlongPolylineMeters;
  const projected: LatLon = [closest.projectedPoint[0], closest.projectedPoint[1]];

  if (side === 'end') {
    if (along >= total - 1) return [...path, station];
    return [...path.slice(0, closest.segmentIndex + 1), projected];
  }
  if (along <= 1) return [station, ...path];
  return [projected, ...path.slice(closest.segmentIndex + 1)];
}

/**
 * The from/to station of a segment path item nearest to a path end, when that end
 * is more than STATION_SNAP_METERS away. Explicit [lat, lon] items are taken as-is.
 */
function nearestSegmentStation(db: FixtureRailwayDb, item: PathItem, end: LatLon): LatLon | null {
  if (typeof item !== 'string') return null;
  const segment = db.segment(item);
  const candidates = [segment.fromStationId, segment.toStationId]
    .map((id) => db.station(id))
    .filter((station) => station !== undefined)
    .map((station) => [station.latitude, station.longitude] as LatLon)
    .sort((a, b) => distance(a, end) - distance(b, end));
  const nearest = candidates[0];
  return nearest && distance(nearest, end) > STATION_SNAP_METERS ? nearest : null;
}

function pointAlong(path: LatLon[], cumulative: number[], meters: number): { point: LatLon; bearing: number } {
  const clamped = Math.min(Math.max(meters, 0), cumulative[cumulative.length - 1]);
  let index = 1;
  while (index < cumulative.length - 1 && cumulative[index] < clamped) index++;
  const [a, b] = [path[index - 1], path[index]];
  const span = cumulative[index] - cumulative[index - 1];
  const ratio = span > 0 ? (clamped - cumulative[index - 1]) / span : 0;
  return {
    point: [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio],
    bearing: calculateBearing(a[0], a[1], b[0], b[1]),
  };
}

function offsetMeters(point: LatLon, northMeters: number, eastMeters: number): LatLon {
  const metersPerDegLat = 111_320;
  const metersPerDegLon = metersPerDegLat * Math.cos((point[0] * Math.PI) / 180);
  return [point[0] + northMeters / metersPerDegLat, point[1] + eastMeters / metersPerDegLon];
}

/**
 * The ridden polyline of every run, in order: segments chained and oriented, station
 * stops moved onto the platform, and the join to the previous run trimmed. Exported so
 * tests can assert the geometry never doubles back without GPS noise in the way.
 */
export function buildTracePaths(db: FixtureRailwayDb, runs: TraceRun[]): LatLon[][] {
  const paths: LatLon[][] = [];
  let previousEnd: LatLon | null = null;
  runs.forEach((run, runIndex) => {
    let path = buildRunPolyline(db, run.path, previousEnd, runs[runIndex + 1]?.path[0] ?? null);
    // The previous run ended on a platform, which can sit a little way along this run's
    // polyline. Start from that point instead of doubling back to the segment's own start.
    if (previousEnd && path.length > 2) {
      const rest = path.slice(1);
      const onward = findClosestPointOnPolyline(previousEnd[0], previousEnd[1], rest);
      if (onward.distanceMeters <= 150 && onward.distanceAlongPolylineMeters > 1) {
        const projected: LatLon = [onward.projectedPoint[0], onward.projectedPoint[1]];
        path = [previousEnd, projected, ...rest.slice(onward.segmentIndex + 1)];
      }
    }
    // Stops happen at platforms, not at polyline ends (which can sit hundreds of metres away on a junction).
    if (runIndex === 0) path = snapToStation(db, run.path[0], path, 'start');
    if (run.dwellAtEndS !== undefined) path = snapToStation(db, run.path[run.path.length - 1], path, 'end');
    paths.push(path);
    previousEnd = path[path.length - 1];
  });
  return paths;
}

/**
 * Deterministic 1 Hz GPS trace along the runs: trapezoidal speed between stops,
 * cross-track noise, station dwells with near-zero OS speed and no heading.
 */
export function generateTrace(
  db: FixtureRailwayDb,
  seed: string,
  runs: TraceRun[],
  options: { initialDwellS?: number; startTimestampMs?: number } = {}
): TracePoint[] {
  const random = createRandom(seed);
  const points: TracePoint[] = [];
  const paths = buildTracePaths(db, runs);
  let timestampMs = options.startTimestampMs ?? TRACE_START_TIMESTAMP_MS;
  let previousEnd: LatLon | null = null;

  const emitStationary = (at: LatLon, seconds: number, runIndex: number, phase: TracePoint['phase'], gps: GpsQuality, secondsIntoRun: number) => {
    const ticks = Math.max(0, Math.round(seconds));
    for (let i = 0; i < ticks; i++) {
      const [lat, lon] = offsetMeters(at, random.gaussian() * gps.noiseSigmaMeters * 0.6, random.gaussian() * gps.noiseSigmaMeters * 0.6);
      if (!gps.dropFixes) {
        points.push({
          sample: {
            latitude: lat,
            longitude: lon,
            accuracyMeters: Math.round(gps.accuracyMeters[0] + random.next() * (gps.accuracyMeters[1] - gps.accuracyMeters[0])),
            speedMps: gps.nullSpeedHeading ? null : Math.abs(random.gaussian() * 0.15),
            headingDegrees: null,
            timestampMs,
          },
          runIndex,
          phase,
          secondsIntoRun: secondsIntoRun + i,
        });
      }
      timestampMs += 1_000;
    }
  };

  runs.forEach((run, runIndex) => {
    const gps = run.gps ?? OPEN_SKY_GPS;
    const path = paths[runIndex];
    const cumulative = [0];
    for (let i = 1; i < path.length; i++) cumulative.push(cumulative[i - 1] + distance(path[i - 1], path[i]));
    const length = cumulative[cumulative.length - 1];

    const startsFromRest = runIndex === 0 || runs[runIndex - 1].dwellAtEndS !== undefined;
    const endsAtRest = run.dwellAtEndS !== undefined || runIndex === runs.length - 1;
    const maxSpeedMps = run.maxSpeedKmh / 3.6;

    if (runIndex === 0 && (options.initialDwellS ?? 10) > 0) {
      emitStationary(path[0], options.initialDwellS ?? 10, runIndex, 'initial-dwell', gps, 0);
    }

    let travelled = 0;
    let secondsIntoRun = 0;
    while (travelled < length) {
      let speed = maxSpeedMps;
      if (startsFromRest) speed = Math.min(speed, Math.max(MIN_MOVING_SPEED_MPS, Math.sqrt(2 * ACCELERATION_MPS2 * travelled)));
      if (endsAtRest) speed = Math.min(speed, Math.max(MIN_MOVING_SPEED_MPS, Math.sqrt(2 * ACCELERATION_MPS2 * (length - travelled))));
      travelled = Math.min(length, travelled + speed);

      const { point, bearing } = pointAlong(path, cumulative, travelled);
      const crossTrack = random.gaussian() * gps.noiseSigmaMeters;
      const alongTrack = random.gaussian() * gps.noiseSigmaMeters * 0.5;
      const radians = (bearing * Math.PI) / 180;
      const north = Math.cos(radians) * alongTrack - Math.sin(radians) * crossTrack;
      const east = Math.sin(radians) * alongTrack + Math.cos(radians) * crossTrack;
      const [lat, lon] = offsetMeters(point, north, east);
      const reportedSpeed = Math.max(0, speed + random.gaussian() * 0.3);

      if (!gps.dropFixes) {
        points.push({
          sample: {
            latitude: lat,
            longitude: lon,
            accuracyMeters: Math.round(gps.accuracyMeters[0] + random.next() * (gps.accuracyMeters[1] - gps.accuracyMeters[0])),
            speedMps: gps.nullSpeedHeading ? null : Math.round(reportedSpeed * 10) / 10,
            headingDegrees: gps.nullSpeedHeading || speed <= 2 ? null : (bearing + random.gaussian() * 4 + 360) % 360,
            timestampMs,
          },
          runIndex,
          phase: 'run',
          secondsIntoRun,
        });
      }
      timestampMs += 1_000;
      secondsIntoRun++;
    }

    previousEnd = path[path.length - 1];
    if (run.dwellAtEndS !== undefined) emitStationary(previousEnd, run.dwellAtEndS, runIndex, 'dwell', gps, secondsIntoRun);
  });

  return points;
}
