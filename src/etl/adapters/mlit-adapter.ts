import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { RailwaySourceAdapter, RawRailwayDataset } from './source-adapter';
import { SourceLicenseMetadata, DataProvenance } from '../../domain/models/provenance';
import { RailwayLine, Station, TrackSegment } from '../../domain/models/railway';
import { haversineDistance } from '../../domain/geo/distance';

type GeoJsonFeature = {
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown };
};
type GeoJsonFeatureCollection = { type?: string; features?: GeoJsonFeature[] };

export type MlitRailwayAdapterOptions = {
  sourceDirectory?: string;
  strict?: boolean;
};

const KANTO_BUFFER = { minLat: 34.5, maxLat: 37.75, minLon: 138.0, maxLon: 141.5 };

export class MlitRailwayAdapter implements RailwaySourceAdapter {
  public sourceId = 'mlit-n02-23';

  constructor(private options: MlitRailwayAdapterOptions = {}) {}

  public async getLicenseMetadata(): Promise<SourceLicenseMetadata> {
    return {
      licenseId: 'CC-BY-4.0',
      name: '国土交通省 国土数値情報（鉄道データ N02-23）',
      url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2023.html',
      attributionRequired: true,
      attributionText: '「国土数値情報（鉄道データ N02-23）」（国土交通省）を加工して作成',
      redistributionAllowed: true,
    };
  }

  public async load(): Promise<RawRailwayDataset> {
    const sourceDirectory = this.options.sourceDirectory ?? process.env.MLIT_N02_DIR;
    if (!sourceDirectory) {
      if (this.options.strict) {
        throw new Error('MLIT_N02_DIR is required for a publishable Kanto dataset build');
      }
      console.log('[MlitRailwayAdapter] MLIT_N02_DIR is not set. Building dataset from bundled JSON data sources.');
      return { lines: [], stations: [], segments: [] };
    }

    const sectionPath = this.findSourceFile(sourceDirectory, 'N02-23_RailroadSection.geojson');
    const stationPath = this.findSourceFile(sourceDirectory, 'N02-23_Station.geojson');
    const sections = this.readFeatureCollection(sectionPath);
    const stationFeatures = this.readFeatureCollection(stationPath);
    const provenance: DataProvenance = {
      sourceId: this.sourceId,
      sourceVersion: 'N02-23',
      acquiredAt: new Date().toISOString(),
      licenseId: 'CC-BY-4.0',
      attributionText: '「国土数値情報（鉄道データ N02-23）」（国土交通省）を加工して作成',
      manuallyCorrected: false,
    };

    const lineByKey = new Map<string, RailwayLine>();
    const stationsByLine = new Map<string, Station[]>();
    for (const feature of stationFeatures) {
      const coordinates = this.lineCoordinates(feature);
      if (!coordinates || !coordinates.some(([lat, lon]) => this.inKanto(lat, lon))) continue;
      const key = this.lineKey(feature);
      if (!key) continue;
      const line = this.lineFromFeature(key, feature, provenance);
      lineByKey.set(key, line);
      const midpoint = coordinates[Math.floor(coordinates.length / 2)];
      const stationCode = String(feature.properties?.N02_005c ?? this.hash(`${key}:${midpoint.join(',')}`));
      const station: Station = {
        id: `mlit-station-${this.hash(`${key}:${stationCode}`)}`,
        lineId: line.id,
        name: String(feature.properties?.N02_005 ?? '駅名不明'),
        sequence: 0,
        latitude: midpoint[0],
        longitude: midpoint[1],
        provenance: [provenance],
      };
      const list = stationsByLine.get(line.id) ?? [];
      if (!list.some((candidate) => candidate.id === station.id)) list.push(station);
      stationsByLine.set(line.id, list);
    }

    const rawSegmentsByLine = new Map<string, TrackSegment[]>();
    for (const feature of sections) {
      const coordinates = this.lineCoordinates(feature);
      if (!coordinates || !coordinates.some(([lat, lon]) => this.inKanto(lat, lon))) continue;
      const key = this.lineKey(feature);
      if (!key) continue;
      const line = lineByKey.get(key) ?? this.lineFromFeature(key, feature, provenance);
      lineByKey.set(key, line);
      const candidates = stationsByLine.get(line.id) ?? [];
      const from = this.nearestStation(coordinates[0], candidates);
      const to = this.nearestStation(coordinates[coordinates.length - 1], candidates);
      if (!from || !to || from.station.id === to.station.id || from.distance > 1500 || to.distance > 1500) continue;

      const endpointKey = [from.station.id, to.station.id].sort().join(':');
      const segment: TrackSegment = {
        id: `mlit-segment-${this.hash(`${line.id}:${endpointKey}`)}`,
        lineId: line.id,
        fromStationId: from.station.id,
        toStationId: to.station.id,
        coordinates,
        provenance: [provenance],
      };
      const list = rawSegmentsByLine.get(line.id) ?? [];
      const existingIndex = list.findIndex((candidate) => candidate.id === segment.id);
      if (existingIndex < 0 || list[existingIndex].coordinates.length < coordinates.length) {
        if (existingIndex >= 0) list.splice(existingIndex, 1, segment);
        else list.push(segment);
      }
      rawSegmentsByLine.set(line.id, list);
    }

    const lines: RailwayLine[] = [];
    const stations: Station[] = [];
    const segments: TrackSegment[] = [];
    for (const line of lineByKey.values()) {
      const lineStations = stationsByLine.get(line.id) ?? [];
      const lineSegments = rawSegmentsByLine.get(line.id) ?? [];
      const orderedStations = this.orderSimpleConnectedLine(lineStations, lineSegments);
      if (!orderedStations) continue;
      lines.push(line);
      stations.push(...orderedStations.map((station, index) => ({ ...station, sequence: index + 1 })));
      segments.push(...lineSegments);
    }

    return { lines, stations, segments };
  }

  private findSourceFile(directory: string, filename: string): string {
    const candidates = [path.join(directory, filename), path.join(directory, 'UTF-8', filename)];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error(`MLIT source file not found: ${filename} under ${directory}`);
    return found;
  }

  private readFeatureCollection(filePath: string): GeoJsonFeature[] {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as GeoJsonFeatureCollection;
    if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
      throw new Error(`Invalid MLIT GeoJSON FeatureCollection: ${filePath}`);
    }
    return parsed.features;
  }

  private lineCoordinates(feature: GeoJsonFeature): Array<[number, number]> | null {
    if (feature.geometry?.type !== 'LineString' || !Array.isArray(feature.geometry.coordinates)) return null;
    const converted = (feature.geometry.coordinates as unknown[]).map((coordinate) => {
      if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
      const lon = Number(coordinate[0]);
      const lat = Number(coordinate[1]);
      return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] as [number, number] : null;
    });
    return converted.every((coordinate): coordinate is [number, number] => coordinate !== null)
      ? converted
      : null;
  }

  private lineKey(feature: GeoJsonFeature): string | null {
    const name = feature.properties?.N02_003;
    const operator = feature.properties?.N02_004;
    return typeof name === 'string' && typeof operator === 'string' ? `${operator}\u0000${name}` : null;
  }

  private lineFromFeature(key: string, feature: GeoJsonFeature, provenance: DataProvenance): RailwayLine {
    return {
      id: `mlit-line-${this.hash(key)}`,
      operatorId: `mlit-operator-${this.hash(String(feature.properties?.N02_004 ?? 'unknown'))}`,
      operatorName: String(feature.properties?.N02_004 ?? '事業者不明'),
      name: String(feature.properties?.N02_003 ?? '路線名不明'),
      provenance: [provenance],
    };
  }

  private nearestStation(point: [number, number], stations: Station[]) {
    let nearest: { station: Station; distance: number } | null = null;
    for (const station of stations) {
      const distance = haversineDistance(point[0], point[1], station.latitude, station.longitude);
      if (!nearest || distance < nearest.distance) nearest = { station, distance };
    }
    return nearest;
  }

  private orderSimpleConnectedLine(stations: Station[], segments: TrackSegment[]): Station[] | null {
    if (stations.length < 2 || segments.length < 1) return null;
    const stableOrder = () => [...stations].sort((a, b) => a.id.localeCompare(b.id));
    const stationById = new Map(stations.map((station) => [station.id, station]));
    const adjacency = new Map<string, string[]>();
    for (const segment of segments) {
      if (!stationById.has(segment.fromStationId) || !stationById.has(segment.toStationId)) return null;
      adjacency.set(segment.fromStationId, [...(adjacency.get(segment.fromStationId) ?? []), segment.toStationId]);
      adjacency.set(segment.toStationId, [...(adjacency.get(segment.toStationId) ?? []), segment.fromStationId]);
    }
    // MLIT uses one line identity for services with branches (for example JR Central and
    // Sobu). The topology builder splits those branches into routes later, so retaining
    // their stations and segments here is essential. A stable order is enough for that
    // split; only a simple path needs its graph traversal order.
    if ([...adjacency.values()].some((neighbors) => new Set(neighbors).size > 2)) {
      return stableOrder();
    }

    const connectedIds = [...adjacency.keys()];
    const endpoints = connectedIds.filter((id) => new Set(adjacency.get(id)).size === 1).sort();
    if (endpoints.length !== 0 && endpoints.length !== 2) return stableOrder();
    let current = endpoints[0] ?? connectedIds.sort()[0];
    const ordered: Station[] = [];
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      ordered.push(stationById.get(current)!);
      current = (adjacency.get(current) ?? []).find((id) => !visited.has(id)) ?? '';
    }
    return visited.size === connectedIds.length ? ordered : stableOrder();
  }

  private inKanto(lat: number, lon: number): boolean {
    return lat >= KANTO_BUFFER.minLat && lat <= KANTO_BUFFER.maxLat &&
      lon >= KANTO_BUFFER.minLon && lon <= KANTO_BUFFER.maxLon;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
  }
}
