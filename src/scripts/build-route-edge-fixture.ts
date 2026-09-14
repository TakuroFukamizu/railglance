/**
 * Builds the real-geometry fixture used by tests/railway/route-edge-cases.
 *
 * The fixture is a slice of the published Kanto dataset (MLIT N02-23 derived)
 * around the corridors where route matching is known to waver: the
 * Yamanote / Keihin-Tohoku forks at Tabata and Shinagawa, Tokyo-Shinagawa where
 * the Tokaido Shinkansen runs beside the conventional lines, and the
 * Chuo / Sobu split at Ochanomizu and Ryogoku.
 *
 * Every segment with a vertex within FIXTURE_RADIUS_METERS of a corridor segment
 * is kept — subways included — because production scores all of them as
 * candidates. Run again after a dataset release:
 *
 *   pnpm fixture:route-edge [--version 1.4.0] [--base-url https://...]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { gridDisk, latLngToCell } from 'h3-js';
import { haversineDistance } from '../domain/geo/distance';
import { RailwayLine, Station, TrackSegment } from '../domain/models/railway';

const DEFAULT_BASE_URL = 'https://pub-4a9074c214e242f3a141a97365372f33.r2.dev';
const DEFAULT_VERSION = '1.4.0';
const FIXTURE_RADIUS_METERS = 1600;
const OUTPUT_URL = new URL('../../tests/railway/route-edge-cases/fixtures/tokyo-core-corridors.json', import.meta.url);

/** Segments the edge-case traces ride on. Neighbours within the radius are pulled in automatically. */
export const CORRIDOR_SEGMENT_IDS = [
  // Tabata fork: Yamanote (west) vs Keihin-Tohoku (north) vs Utsunomiya/Takasaki via Oku.
  'mlit-segment-f4361a258450', // 東北線（日暮里〜上野） 日暮里-鶯谷
  'mlit-segment-407c78205c86', // 東北線（田端〜日暮里・1） 西日暮里-日暮里
  'mlit-segment-93191c6a8b55', // 東北線（田端〜日暮里・1） 田端-西日暮里
  'mlit-segment-bf95eabf7b71', // JR山手線 田端-駒込
  'mlit-segment-c8b4cf25d168', // JR山手線 駒込-巣鴨
  'mlit-segment-61541445fd4c', // 東北線（田端〜東十条・2） 田端-上中里
  'mlit-segment-9d29ffa6c36b', // 東北線（田端〜東十条・2） 上中里-王子
  // Tokyo - Shinagawa and the Shinagawa fork.
  'mlit-segment-b8334a524745', // 東北線（東京〜秋葉原） 東京-神田
  'mlit-segment-811bda66c865', // 東北線（東京〜秋葉原） 神田-秋葉原
  'mlit-segment-15529180bed5', // 東北線（上野〜秋葉原・1） 御徒町-秋葉原
  'mlit-segment-a720eb8aa2be', // 東北線（上野〜秋葉原・1） 上野-御徒町
  'mlit-segment-c64806aa8ed2', // 東海道線（新橋・循環） 東京-有楽町
  'mlit-segment-e226dec05ff8', // 東海道線（新橋・循環） 有楽町-新橋
  'mlit-segment-d28b146ffcb4', // 東海道線（新橋・循環） 新橋-東京
  'mlit-segment-0759db0575b7', // 東海道線（新橋〜品川）
  'mlit-segment-99811a2ca443', // 東海道線（田町〜新橋） 浜松町-新橋
  'mlit-segment-b8e5061b7ff1', // 東海道線（田町〜新橋） 田町-浜松町
  'mlit-segment-e3c0d8717098', // 東海道線（田町〜品川・1） 田町-高輪ゲートウェイ
  'mlit-segment-9a5b3a3e8963', // 東海道線（田町〜品川・1） 高輪ゲートウェイ-品川
  'mlit-segment-2006bd6b189c', // JR山手線 大崎-品川 (only the stub shared with the Tokaido tracks)
  'mlit-segment-9673dddf5064', // JR山手線 五反田-大崎
  'mlit-segment-7cd5a4d0e053', // 東海道線（大井町〜品川）
  'mlit-segment-9ce729141b87', // 東海道新幹線（品川〜新横浜）
  // Ochanomizu - Ryogoku - Kameido.
  'mlit-segment-37f18e3fada9', // 中央線（神田〜高尾） 御茶ノ水-水道橋
  'mlit-segment-27cbe7a65a63', // 中央線（神田〜高尾） 神田-御茶ノ水
  'mlit-segment-985d48f84578', // 総武線（御茶ノ水〜両国） 御茶ノ水-秋葉原
  'mlit-segment-bb8462c5020a', // 総武線（御茶ノ水〜両国） 秋葉原-浅草橋
  'mlit-segment-aa772ddff9c4', // 総武線（御茶ノ水〜両国） 浅草橋-両国
  'mlit-segment-609c610c74b9', // 総武線（両国〜東京） 新日本橋-東京
  'mlit-segment-90360139449f', // 総武線（両国〜東京） 馬喰町-新日本橋
  'mlit-segment-04883a324733', // 総武線（両国〜東京） 両国-馬喰町
  'mlit-segment-7683be07ad58', // 総武線（両国〜銚子） 両国-錦糸町
  'mlit-segment-3cfed8720eca', // 総武線（両国〜銚子） 錦糸町-亀戸
];

/**
 * Dataset v1.4.0 has no Tokaido Shinkansen between Tokyo and Shinagawa (only
 * 品川〜新横浜 survives the ETL quality gates). The real tracks run immediately
 * east of the Tokaido main line, so the synthetic line is that polyline shifted
 * east. The offset alone sets how hard the parallel-running cases are.
 */
export const SYNTHETIC_SHINKANSEN_OFFSET_METERS = 35;
const SYNTHETIC_LINE_ID = 'synthetic-tokaido-shinkansen-tokyo-shinagawa';
const SYNTHETIC_SEGMENT_ID = 'synthetic-segment-tokaido-shinkansen-tokyo-shinagawa';
const SHINAGAWA_SHINKANSEN_SEGMENT_ID = 'mlit-segment-9ce729141b87';

type H3Tile = { lines: RailwayLine[]; stations: Station[]; segments: TrackSegment[] };

export type RouteEdgeFixture = {
  meta: {
    datasetVersion: string;
    source: string;
    attribution: string;
    generatedBy: string;
    radiusMeters: number;
    notes: string[];
  };
  lines: RailwayLine[];
  stations: Station[];
  segments: TrackSegment[];
};

function parseArgs(argv: string[]): { baseUrl: string; version: string } {
  const valueOf = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    baseUrl: valueOf('--base-url') ?? process.env.VITE_RAILWAY_DATA_BASE_URL ?? DEFAULT_BASE_URL,
    version: valueOf('--version') ?? DEFAULT_VERSION,
  };
}

async function fetchTiles(baseUrl: string, version: string, cellIds: Iterable<string>): Promise<H3Tile[]> {
  const tiles: H3Tile[] = [];
  for (const cellId of cellIds) {
    const response = await fetch(`${baseUrl}/datasets/v${version}/h3/6/${cellId}.json`);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`HTTP ${response.status} on tile ${cellId}`);
    tiles.push((await response.json()) as H3Tile);
  }
  return tiles;
}

function withinRadius(segment: TrackSegment, anchors: Array<[number, number]>, radiusMeters: number): boolean {
  return segment.coordinates.some(([lat, lon]) =>
    anchors.some(([anchorLat, anchorLon]) => haversineDistance(lat, lon, anchorLat, anchorLon) <= radiusMeters)
  );
}

/** Shifts a [lat, lon] polyline sideways, choosing the normal that points east. */
function offsetEast(coordinates: Array<[number, number]>, meters: number): Array<[number, number]> {
  const metersPerDegLat = 111_320;
  return coordinates.map(([lat, lon], index) => {
    const prev = coordinates[Math.max(0, index - 1)];
    const next = coordinates[Math.min(coordinates.length - 1, index + 1)];
    const metersPerDegLon = metersPerDegLat * Math.cos((lat * Math.PI) / 180);
    const dy = (next[0] - prev[0]) * metersPerDegLat;
    const dx = (next[1] - prev[1]) * metersPerDegLon;
    const length = Math.hypot(dx, dy) || 1;
    let nx = -dy / length;
    let ny = dx / length;
    if (nx < 0) {
      nx = -nx;
      ny = -ny;
    }
    return [lat + (ny * meters) / metersPerDegLat, lon + (nx * meters) / metersPerDegLon];
  });
}

function polylineLength(coordinates: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    total += haversineDistance(coordinates[i - 1][0], coordinates[i - 1][1], coordinates[i][0], coordinates[i][1]);
  }
  return Math.round(total);
}

function buildSyntheticShinkansen(segments: Map<string, TrackSegment>, stations: Map<string, Station>) {
  const tokyoToShimbashi = segments.get('mlit-segment-d28b146ffcb4');
  const shimbashiToShinagawa = segments.get('mlit-segment-0759db0575b7');
  const shinagawaOnward = segments.get(SHINAGAWA_SHINKANSEN_SEGMENT_ID);
  if (!tokyoToShimbashi || !shimbashiToShinagawa || !shinagawaOnward) {
    throw new Error('Corridor segments for the synthetic Tokaido Shinkansen are missing from the dataset');
  }
  // 新橋・循環 is stored Shimbashi -> Tokyo; the Tokaido segment is stored Shimbashi -> Shinagawa.
  const conventional: Array<[number, number]> = [
    ...[...tokyoToShimbashi.coordinates].reverse(),
    ...shimbashiToShinagawa.coordinates,
  ];
  const coordinates = offsetEast(conventional, SYNTHETIC_SHINKANSEN_OFFSET_METERS);
  // Join onto the real Shinagawa -> Shin-Yokohama polyline so topology continues southward.
  coordinates.push(shinagawaOnward.coordinates[0]);

  const shinagawa = stations.get(shinagawaOnward.fromStationId);
  if (!shinagawa) throw new Error('Shinagawa station of the Tokaido Shinkansen is missing');
  const line: RailwayLine = {
    id: SYNTHETIC_LINE_ID,
    operatorId: 'synthetic',
    operatorName: '東海旅客鉄道',
    name: '東海道新幹線（東京〜品川・合成）',
  };
  const tokyo: Station = {
    id: 'synthetic-station-tokaido-shinkansen-tokyo',
    lineId: line.id,
    name: '東京',
    sequence: 1,
    latitude: coordinates[0][0],
    longitude: coordinates[0][1],
  };
  const shinagawaEnd: Station = {
    id: 'synthetic-station-tokaido-shinkansen-shinagawa',
    lineId: line.id,
    name: '品川',
    sequence: 2,
    latitude: shinagawa.latitude,
    longitude: shinagawa.longitude,
  };
  const segment: TrackSegment = {
    id: SYNTHETIC_SEGMENT_ID,
    lineId: line.id,
    routeId: `route-${line.id}-main`,
    fromStationId: tokyo.id,
    toStationId: shinagawaEnd.id,
    coordinates,
    lengthMeters: polylineLength(coordinates),
    startOffsetMeters: 0,
    cumulativeDistanceMeters: 0,
    previousSegmentIds: [],
    nextSegmentIds: [SHINAGAWA_SHINKANSEN_SEGMENT_ID],
  };
  return { line, stations: [tokyo, shinagawaEnd], segment };
}

export async function buildRouteEdgeFixture(baseUrl: string, version: string): Promise<RouteEdgeFixture> {
  // Tabata, Tokyo, Shinagawa, Ochanomizu, Ryogoku - one ring around each covers every corridor segment.
  const seedPoints: Array<[number, number]> = [
    [35.7367, 139.7625],
    [35.6812, 139.7671],
    [35.6285, 139.7388],
    [35.6993, 139.7663],
    [35.6957, 139.7945],
  ];
  const seedTiles = await fetchTiles(
    baseUrl,
    version,
    new Set(seedPoints.flatMap(([lat, lon]) => gridDisk(latLngToCell(lat, lon, 6), 1)))
  );
  const seedSegments = new Map(seedTiles.flatMap((tile) => tile.segments).map((segment) => [segment.id, segment]));
  const corridor = CORRIDOR_SEGMENT_IDS.map((id) => {
    const segment = seedSegments.get(id);
    if (!segment) throw new Error(`Corridor segment ${id} is not in dataset v${version}`);
    return segment;
  });
  const anchors = corridor.flatMap((segment) => segment.coordinates);

  const cellIds = new Set<string>();
  for (const [lat, lon] of anchors) {
    for (const cellId of gridDisk(latLngToCell(lat, lon, 6), 1)) cellIds.add(cellId);
  }
  const tiles = await fetchTiles(baseUrl, version, cellIds);

  const allLines = new Map(tiles.flatMap((tile) => tile.lines).map((line) => [line.id, line]));
  const allStations = new Map(tiles.flatMap((tile) => tile.stations).map((station) => [station.id, station]));
  const allSegments = new Map(tiles.flatMap((tile) => tile.segments).map((segment) => [segment.id, segment]));

  const strip = <T extends { provenance?: unknown }>(item: T): T => {
    const copy = { ...item };
    delete copy.provenance;
    return copy;
  };

  const segments = [...allSegments.values()]
    .filter((segment) => withinRadius(segment, anchors, FIXTURE_RADIUS_METERS))
    .map(strip);
  const lineIds = new Set(segments.map((segment) => segment.lineId));
  const stationIds = new Set(segments.flatMap((segment) => [segment.fromStationId, segment.toStationId]));
  const lines = [...lineIds].map((id) => allLines.get(id)).filter((line): line is RailwayLine => !!line).map(strip);
  const stations = [...stationIds]
    .map((id) => allStations.get(id))
    .filter((station): station is Station => !!station)
    .map(strip);

  const synthetic = buildSyntheticShinkansen(allSegments, allStations);
  lines.push(synthetic.line);
  stations.push(...synthetic.stations);
  segments.push(synthetic.segment);

  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  return {
    meta: {
      datasetVersion: version,
      source: `${baseUrl}/datasets/v${version}/h3/6/`,
      attribution: '「国土数値情報（鉄道データ N02-23）」（国土交通省）を加工して作成',
      generatedBy: 'pnpm fixture:route-edge (src/scripts/build-route-edge-fixture.ts)',
      radiusMeters: FIXTURE_RADIUS_METERS,
      notes: [
        `${SYNTHETIC_SEGMENT_ID} is synthetic: 東海道線（新橋・循環 新橋-東京 + 新橋〜品川）shifted ${SYNTHETIC_SHINKANSEN_OFFSET_METERS} m east, because dataset v${version} lacks 東海道新幹線 東京〜品川.`,
        'seg-shinkansen-tokyo-ueno (bundled sample, 3-point straight line) and mlit 東北新幹線（大宮〜東京） both describe Tokyo-Ueno; production merges both, so the fixture keeps both.',
      ],
    },
    lines: lines.sort(byId),
    stations: stations.sort(byId),
    segments: segments.sort(byId),
  };
}

async function main() {
  const { baseUrl, version } = parseArgs(process.argv.slice(2));
  const fixture = await buildRouteEdgeFixture(baseUrl, version);
  const outputPath = fileURLToPath(OUTPUT_URL);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(fixture)}\n`);
  console.log(
    `[route-edge-fixture] v${version}: ${fixture.lines.length} lines, ${fixture.stations.length} stations, ` +
      `${fixture.segments.length} segments -> ${path.relative(process.cwd(), outputPath)}`
  );
}

if (process.argv[1]?.includes('build-route-edge-fixture')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
