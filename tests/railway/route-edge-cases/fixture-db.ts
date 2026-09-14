import { readFileSync } from 'fs';
import { haversineDistance } from '../../../src/domain/geo/distance';
import { RailwayLine, Station, TrackSegment } from '../../../src/domain/models/railway';
import { RailwayDatabaseReader } from '../../../src/domain/railway/map-matcher';
import type { RouteEdgeFixture } from '../../../src/scripts/build-route-edge-fixture';

// Parsed at runtime rather than imported so tsc does not infer a type for ~1 MB of coordinates.
export function loadTokyoCoreFixture(): RouteEdgeFixture {
  const url = new URL('./fixtures/tokyo-core-corridors.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as RouteEdgeFixture;
}

/**
 * In-memory reader over the fixture. findSegmentsNear mirrors
 * DexieRailwayDatabase.findSegmentsNear (any vertex within radius * 1.5), so the
 * matcher sees the same candidate set - and the same continuity neighbours - as
 * on a device.
 */
export class FixtureRailwayDb implements RailwayDatabaseReader {
  private lines: Map<string, RailwayLine>;
  private stations: Map<string, Station>;
  private segments: TrackSegment[];
  private segmentsById: Map<string, TrackSegment>;

  constructor(fixture: RouteEdgeFixture) {
    this.lines = new Map(fixture.lines.map((line) => [line.id, line]));
    this.stations = new Map(fixture.stations.map((station) => [station.id, station]));
    this.segments = fixture.segments;
    this.segmentsById = new Map(fixture.segments.map((segment) => [segment.id, segment]));
  }

  async findSegmentsNear(latitude: number, longitude: number, radiusMeters: number): Promise<TrackSegment[]> {
    return this.segments.filter((segment) =>
      segment.coordinates.some(([lat, lon]) => haversineDistance(latitude, longitude, lat, lon) <= radiusMeters * 1.5)
    );
  }

  async getLine(lineId: string): Promise<RailwayLine | undefined> {
    return this.lines.get(lineId);
  }

  async getStation(stationId: string): Promise<Station | undefined> {
    return this.stations.get(stationId);
  }

  segment(segmentId: string): TrackSegment {
    const segment = this.segmentsById.get(segmentId);
    if (!segment) throw new Error(`Segment ${segmentId} is not in the route edge-case fixture`);
    return segment;
  }

  station(stationId: string): Station | undefined {
    return this.stations.get(stationId);
  }

  line(lineId: string): RailwayLine {
    const line = this.lines.get(lineId);
    if (!line) throw new Error(`Line ${lineId} is not in the route edge-case fixture`);
    return line;
  }

  allLines(): RailwayLine[] {
    return [...this.lines.values()];
  }
}
