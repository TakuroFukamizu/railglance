import { H3TileData } from '../../etl/h3-tiler';

export const RAILWAY_DATASET_SCHEMA_VERSION = '1.1.0';

export type LatestDatasetPointer = {
  version: string;
  schemaVersion: string;
  releasedAt: string;
  manifestUrl: string;
};

export type RailwayDatasetManifest = {
  version: string;
  schemaVersion: string;
  generatedAt: string;
  area: string;
  totalLines: number;
  totalRoutes: number;
  totalStations: number;
  totalSegments: number;
  totalTiles: number;
  sources: string[];
  mlitSourced: true;
};

const MLIT_SOURCE_ID = 'mlit-n02-23';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Dataset field "${key}" must be a non-empty string`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Dataset field "${key}" must be a finite number`);
  }
  return value;
}

function requireMlitProvenance(record: Record<string, unknown>): { sources: string[]; mlitSourced: true } {
  if (record.mlitSourced !== true) {
    throw new Error('Dataset manifest must declare official MLIT provenance');
  }
  if (!Array.isArray(record.sources) || !record.sources.every((source) => typeof source === 'string')) {
    throw new Error('Dataset manifest sources must be an array of strings');
  }
  if (!record.sources.includes(MLIT_SOURCE_ID)) {
    throw new Error('Dataset manifest must include the official MLIT source');
  }
  return { sources: record.sources, mlitSourced: true };
}

function assertSupportedSchema(schemaVersion: string): void {
  if (schemaVersion !== RAILWAY_DATASET_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported railway dataset schema ${schemaVersion}; expected ${RAILWAY_DATASET_SCHEMA_VERSION}`
    );
  }
}

export function parseLatestDatasetPointer(value: unknown): LatestDatasetPointer {
  if (!isRecord(value)) throw new Error('latest.json must contain an object');
  const version = requireString(value, 'version');
  const schemaVersion = requireString(value, 'schemaVersion');
  assertSupportedSchema(schemaVersion);
  const manifestUrl = requireString(value, 'manifestUrl');
  if (manifestUrl !== `/datasets/v${version}/manifest.json`) {
    throw new Error(`latest.json manifestUrl does not match version ${version}`);
  }
  return {
    version,
    schemaVersion,
    releasedAt: requireString(value, 'releasedAt'),
    manifestUrl,
  };
}

export function parseRailwayDatasetManifest(value: unknown): RailwayDatasetManifest {
  if (!isRecord(value)) throw new Error('manifest.json must contain an object');
  const schemaVersion = requireString(value, 'schemaVersion');
  assertSupportedSchema(schemaVersion);
  const provenance = requireMlitProvenance(value);
  return {
    version: requireString(value, 'version'),
    schemaVersion,
    generatedAt: requireString(value, 'generatedAt'),
    area: requireString(value, 'area'),
    totalLines: requireNumber(value, 'totalLines'),
    totalRoutes: requireNumber(value, 'totalRoutes'),
    totalStations: requireNumber(value, 'totalStations'),
    totalSegments: requireNumber(value, 'totalSegments'),
    totalTiles: requireNumber(value, 'totalTiles'),
    ...provenance,
  };
}

export function parseH3TileData(value: unknown, expectedCellId: string): H3TileData {
  if (!isRecord(value)) throw new Error('H3 tile must contain an object');
  if (requireString(value, 'cellId') !== expectedCellId) {
    throw new Error(`H3 tile cellId does not match requested cell ${expectedCellId}`);
  }
  if (requireNumber(value, 'resolution') !== 6) {
    throw new Error('H3 tile resolution must be 6');
  }
  for (const key of ['lines', 'routes', 'stations', 'segments']) {
    if (!Array.isArray(value[key])) throw new Error(`H3 tile field "${key}" must be an array`);
  }

  for (const line of value.lines as unknown[]) {
    if (!isRecord(line)) throw new Error('H3 tile line must be an object');
    requireString(line, 'id');
    requireString(line, 'operatorId');
    requireString(line, 'name');
  }
  for (const route of value.routes as unknown[]) {
    if (!isRecord(route)) throw new Error('H3 tile route must be an object');
    requireString(route, 'id');
    requireString(route, 'lineId');
    requireString(route, 'direction');
    requireNumber(route, 'totalLengthMeters');
    if (!Array.isArray(route.stationIds) || !Array.isArray(route.segmentIds)) {
      throw new Error('H3 tile route stationIds and segmentIds must be arrays');
    }
  }
  for (const station of value.stations as unknown[]) {
    if (!isRecord(station)) throw new Error('H3 tile station must be an object');
    requireString(station, 'id');
    requireString(station, 'lineId');
    requireString(station, 'name');
    requireNumber(station, 'sequence');
    requireNumber(station, 'latitude');
    requireNumber(station, 'longitude');
  }

  for (const segment of value.segments as unknown[]) {
    if (!isRecord(segment)) throw new Error('H3 tile segment must be an object');
    requireString(segment, 'id');
    requireString(segment, 'lineId');
    requireString(segment, 'routeId');
    requireString(segment, 'fromStationId');
    requireString(segment, 'toStationId');
    requireNumber(segment, 'startOffsetMeters');
    if (!Array.isArray(segment.coordinates) || segment.coordinates.length < 2) {
      throw new Error('H3 tile segment coordinates must contain at least two points');
    }
    for (const coordinate of segment.coordinates) {
      if (!Array.isArray(coordinate) || coordinate.length < 2 ||
        typeof coordinate[0] !== 'number' || typeof coordinate[1] !== 'number' ||
        !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
        throw new Error('H3 tile segment coordinates must contain finite [latitude, longitude] pairs');
      }
    }
  }

  return value as H3TileData;
}
