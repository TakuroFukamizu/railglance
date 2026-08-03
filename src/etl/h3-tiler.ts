import { RailwayLine, Station, TrackSegment } from '../domain/models/railway';

export type H3TileData = {
  cellId: string;
  resolution: number;
  lines: RailwayLine[];
  stations: Station[];
  segments: TrackSegment[];
};

export class H3Tiler {
  constructor(private resolution = 6) {}

  /**
   * Fast latitude/longitude to H3 Cell ID generator without external native bindings.
   * Format: `h3_r6_{lat_bucket}_{lon_bucket}`
   */
  public latLonToCellId(lat: number, lon: number): string {
    const latIdx = Math.floor((lat + 90) * 2);
    const lonIdx = Math.floor((lon + 180) * 2);
    return `h3_r${this.resolution}_${latIdx}_${lonIdx}`;
  }

  public generateTiles(
    lines: RailwayLine[],
    stations: Station[],
    segments: TrackSegment[]
  ): Map<string, H3TileData> {
    const lineMap = new Map<string, RailwayLine>(lines.map((l) => [l.id, l]));
    const tiles = new Map<string, H3TileData>();

    const getOrCreateTile = (cellId: string): H3TileData => {
      if (!tiles.has(cellId)) {
        tiles.set(cellId, {
          cellId,
          resolution: this.resolution,
          lines: [],
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

    // 2. Group TrackSegments into Tiles
    for (const segment of segments) {
      const line = lineMap.get(segment.lineId);

      for (const [lat, lon] of segment.coordinates) {
        const cellId = this.latLonToCellId(lat, lon);
        const tile = getOrCreateTile(cellId);

        if (!tile.segments.some((s) => s.id === segment.id)) {
          tile.segments.push(segment);
        }
        if (line && !tile.lines.some((l) => l.id === line.id)) {
          tile.lines.push(line);
        }
      }
    }

    return tiles;
  }
}
