import { RailwayLine, RailwayRoute, Station, TrackSegment } from '../domain/models/railway';
import { gridDisk, latLngToCell } from 'h3-js';
import { haversineDistance } from '../domain/geo/distance';

export type H3TileData = {
  cellId: string;
  resolution: number;
  lines: RailwayLine[];
  routes: RailwayRoute[];
  stations: Station[];
  segments: TrackSegment[];
};

export class H3Tiler {
  constructor(private resolution = 6) {}

  public latLonToCellId(lat: number, lon: number): string {
    return latLngToCell(lat, lon, this.resolution);
  }

  public coverageCellIds(lat: number, lon: number, ringSize = 1): string[] {
    return gridDisk(this.latLonToCellId(lat, lon), ringSize);
  }

  public generateTiles(
    lines: RailwayLine[],
    routes: RailwayRoute[],
    stations: Station[],
    segments: TrackSegment[]
  ): Map<string, H3TileData> {
    const lineMap = new Map<string, RailwayLine>(lines.map((l) => [l.id, l]));
    const routeMap = new Map<string, RailwayRoute>(routes.map((r) => [r.id, r]));
    const stationMap = new Map<string, Station>(stations.map((station) => [station.id, station]));
    const tiles = new Map<string, H3TileData>();

    const getOrCreateTile = (cellId: string): H3TileData => {
      if (!tiles.has(cellId)) {
        tiles.set(cellId, {
          cellId,
          resolution: this.resolution,
          lines: [],
          routes: [],
          stations: [],
          segments: [],
        });
      }
      return tiles.get(cellId)!;
    };

    // 1. Group Stations into Tiles
    for (const station of stations) {
      const cellId = this.latLonToCellId(station.latitude, station.longitude);
      const tile = getOrCreateTile(cellId);
      tile.stations.push(station);

      const line = lineMap.get(station.lineId);
      if (line && !tile.lines.some((l) => l.id === line.id)) {
        tile.lines.push(line);
      }
    }

    // 2. Group TrackSegments and Routes into Tiles
    for (const segment of segments) {
      const line = lineMap.get(segment.lineId);
      const route = segment.routeId ? routeMap.get(segment.routeId) : undefined;

      for (const cellId of this.segmentCellIds(segment)) {
        const tile = getOrCreateTile(cellId);

        if (!tile.segments.some((s) => s.id === segment.id)) {
          tile.segments.push(segment);
        }
        if (line && !tile.lines.some((l) => l.id === line.id)) {
          tile.lines.push(line);
        }
        if (route && !tile.routes.some((r) => r.id === route.id)) {
          tile.routes.push(route);
        }
        for (const stationId of [segment.fromStationId, segment.toStationId]) {
          const station = stationMap.get(stationId);
          if (station && !tile.stations.some((candidate) => candidate.id === station.id)) {
            tile.stations.push(station);
          }
        }
      }
    }

    return tiles;
  }

  private segmentCellIds(segment: TrackSegment): Set<string> {
    const cells = new Set<string>();
    const sampleIntervalMeters = 500;

    for (let index = 0; index < segment.coordinates.length - 1; index++) {
      const [startLat, startLon] = segment.coordinates[index];
      const [endLat, endLon] = segment.coordinates[index + 1];
      const distanceMeters = haversineDistance(startLat, startLon, endLat, endLon);
      const steps = Math.max(1, Math.ceil(distanceMeters / sampleIntervalMeters));

      for (let step = 0; step <= steps; step++) {
        const ratio = step / steps;
        const lat = startLat + (endLat - startLat) * ratio;
        const lon = startLon + (endLon - startLon) * ratio;
        cells.add(this.latLonToCellId(lat, lon));
      }
    }

    if (segment.coordinates.length === 1) {
      const [lat, lon] = segment.coordinates[0];
      cells.add(this.latLonToCellId(lat, lon));
    }

    return cells;
  }
}
