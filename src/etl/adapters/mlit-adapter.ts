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
    const stationCodeById = new Map<string, string>();
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
      stationCodeById.set(station.id, stationCode);
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
    for (const [key, line] of lineByKey) {
      const lineStations = stationsByLine.get(line.id) ?? [];
      const lineSegments = rawSegmentsByLine.get(line.id) ?? [];
      const orderedStations = this.orderSimpleConnectedLine(lineStations, lineSegments);
      if (orderedStations) {
        lines.push(line);
        stations.push(...orderedStations.map((station, index) => ({ ...station, sequence: index + 1 })));
        segments.push(...lineSegments);
        continue;
      }
      for (const chain of this.decomposeIntoLinearChains(lineStations, lineSegments)) {
        if (chain.stations.length < 2 || chain.segments.length < 1) continue;
        const discriminator = chain.stations.map((station) => station.id).join(':');
        const newLineId = `mlit-line-${this.hash(`${key}:${discriminator}`)}`;
        const remappedIds = new Map<string, string>();
        const remappedStations = chain.stations.map((station, index) => {
          const stationCode = stationCodeById.get(station.id) ?? station.id;
          const newStationId = `mlit-station-${this.hash(`${key}:${discriminator}:${stationCode}`)}`;
          remappedIds.set(station.id, newStationId);
          return { ...station, id: newStationId, lineId: newLineId, sequence: index + 1 };
        });
        lines.push({
          ...line,
          id: newLineId,
          name: `${line.name}（${chain.stations[0].name}〜${chain.stations[chain.stations.length - 1].name}）`,
        });
        stations.push(...remappedStations);
        segments.push(...chain.segments.map((segment) => {
          const fromStationId = remappedIds.get(segment.fromStationId) ?? segment.fromStationId;
          const toStationId = remappedIds.get(segment.toStationId) ?? segment.toStationId;
          const endpointKey = [fromStationId, toStationId].sort().join(':');
          return {
            ...segment,
            id: `mlit-segment-${this.hash(`${newLineId}:${endpointKey}`)}`,
            lineId: newLineId,
            fromStationId,
            toStationId,
          };
        }));
      }
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
    const stationById = new Map(stations.map((station) => [station.id, station]));
    const adjacency = new Map<string, string[]>();
    for (const segment of segments) {
      if (!stationById.has(segment.fromStationId) || !stationById.has(segment.toStationId)) return null;
      adjacency.set(segment.fromStationId, [...(adjacency.get(segment.fromStationId) ?? []), segment.toStationId]);
      adjacency.set(segment.toStationId, [...(adjacency.get(segment.toStationId) ?? []), segment.fromStationId]);
    }
    if ([...adjacency.values()].some((neighbors) => new Set(neighbors).size > 2)) return null;

    const connectedIds = [...adjacency.keys()];
    const endpoints = connectedIds.filter((id) => new Set(adjacency.get(id)).size === 1).sort();
    if (endpoints.length !== 0 && endpoints.length !== 2) return null;
    let current = endpoints[0] ?? connectedIds.sort()[0];
    const ordered: Station[] = [];
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      ordered.push(stationById.get(current)!);
      current = (adjacency.get(current) ?? []).find((id) => !visited.has(id)) ?? '';
    }
    return visited.size === connectedIds.length ? ordered : null;
  }

  private decomposeIntoLinearChains(
    stations: Station[],
    segments: TrackSegment[],
  ): Array<{ stations: Station[]; segments: TrackSegment[] }> {
    const stationById = new Map(stations.map((station) => [station.id, station]));
    const adjacency = new Map<string, Set<string>>();
    const segmentByEdge = new Map<string, TrackSegment>();
    for (const segment of segments) {
      if (!stationById.has(segment.fromStationId) || !stationById.has(segment.toStationId)) continue;
      if (segment.fromStationId === segment.toStationId) continue;
      adjacency.set(segment.fromStationId, (adjacency.get(segment.fromStationId) ?? new Set()).add(segment.toStationId));
      adjacency.set(segment.toStationId, (adjacency.get(segment.toStationId) ?? new Set()).add(segment.fromStationId));
      segmentByEdge.set(this.undirectedEdgeKey(segment.fromStationId, segment.toStationId), segment);
    }
    const neighborsOf = (id: string): string[] => [...(adjacency.get(id) ?? [])].sort((a, b) => a.localeCompare(b));
    const chains = this.connectedComponents([...adjacency.keys()], neighborsOf)
      .flatMap((component) => this.chainsInComponent(component, neighborsOf))
      .map((chain) => this.materializeChain(chain, stationById, segmentByEdge))
      .filter((chain) => chain.stations.length >= 2 && chain.segments.length >= 1);
    chains.sort((a, b) => {
      const left = a.stations.map((station) => station.id).join('\0');
      const right = b.stations.map((station) => station.id).join('\0');
      return left.localeCompare(right);
    });
    return chains;
  }

  private connectedComponents(nodes: string[], neighborsOf: (id: string) => string[]): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const start of [...nodes].sort((a, b) => a.localeCompare(b))) {
      if (visited.has(start)) continue;
      const component: string[] = [];
      const queue = [start];
      visited.add(start);
      while (queue.length > 0) {
        const node = queue.shift()!;
        component.push(node);
        for (const neighbor of neighborsOf(node)) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
      component.sort((a, b) => a.localeCompare(b));
      components.push(component);
    }
    components.sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
    return components;
  }

  private chainsInComponent(
    component: string[],
    neighborsOf: (id: string) => string[],
  ): Array<{ stationIds: string[]; isCycle: boolean }> {
    const degree = (id: string) => neighborsOf(id).length;
    const used = new Set<string>();
    const walk = (start: string, first: string): { stationIds: string[]; isCycle: boolean } => {
      used.add(this.undirectedEdgeKey(start, first));
      const stationIds = [start];
      let prev = start;
      let curr = first;
      while (curr !== start) {
        stationIds.push(curr);
        if (degree(curr) !== 2) return { stationIds, isCycle: false };
        const next = neighborsOf(curr).find((id) => id !== prev);
        if (!next) return { stationIds, isCycle: false };
        const edge = this.undirectedEdgeKey(curr, next);
        if (used.has(edge)) return { stationIds, isCycle: next === start };
        used.add(edge);
        prev = curr;
        curr = next;
      }
      return { stationIds, isCycle: true };
    };

    const chains: Array<{ stationIds: string[]; isCycle: boolean }> = [];
    const terminals = component.filter((id) => degree(id) !== 2).sort((a, b) => a.localeCompare(b));
    for (const terminal of terminals) {
      for (const neighbor of neighborsOf(terminal)) {
        if (used.has(this.undirectedEdgeKey(terminal, neighbor))) continue;
        chains.push(walk(terminal, neighbor));
      }
    }
    while (true) {
      const start = component
        .filter((id) => neighborsOf(id).some((neighbor) => !used.has(this.undirectedEdgeKey(id, neighbor))))
        .sort((a, b) => a.localeCompare(b))[0];
      if (!start) break;
      const first = neighborsOf(start).find((neighbor) => !used.has(this.undirectedEdgeKey(start, neighbor)));
      if (!first) break;
      chains.push(walk(start, first));
    }
    return chains.map((chain) => this.canonicalizeChain(chain));
  }

  private canonicalizeChain(chain: { stationIds: string[]; isCycle: boolean }): { stationIds: string[]; isCycle: boolean } {
    const { stationIds, isCycle } = chain;
    if (stationIds.length < 2) return chain;
    if (!isCycle) {
      return stationIds[0].localeCompare(stationIds[stationIds.length - 1]) > 0
        ? { stationIds: [...stationIds].reverse(), isCycle: false }
        : chain;
    }
    const minId = [...stationIds].sort((a, b) => a.localeCompare(b))[0];
    const minIndex = stationIds.indexOf(minId);
    const rotated = [...stationIds.slice(minIndex), ...stationIds.slice(0, minIndex)];
    if (rotated.length >= 3 && rotated[1].localeCompare(rotated[rotated.length - 1]) > 0) {
      return { stationIds: [rotated[0], ...rotated.slice(1).reverse()], isCycle: true };
    }
    return { stationIds: rotated, isCycle: true };
  }

  private materializeChain(
    chain: { stationIds: string[]; isCycle: boolean },
    stationById: Map<string, Station>,
    segmentByEdge: Map<string, TrackSegment>,
  ): { stations: Station[]; segments: TrackSegment[] } {
    const stations = chain.stationIds.flatMap((id) => {
      const station = stationById.get(id);
      return station ? [station] : [];
    });
    const pairs: Array<[string, string]> = [];
    for (let index = 0; index < chain.stationIds.length - 1; index++) {
      pairs.push([chain.stationIds[index], chain.stationIds[index + 1]]);
    }
    if (chain.isCycle && chain.stationIds.length >= 2) {
      pairs.push([chain.stationIds[chain.stationIds.length - 1], chain.stationIds[0]]);
    }
    const segments = pairs.flatMap(([from, to]) => {
      const segment = segmentByEdge.get(this.undirectedEdgeKey(from, to));
      return segment ? [segment] : [];
    });
    return { stations, segments };
  }

  private undirectedEdgeKey(a: string, b: string): string {
    return a.localeCompare(b) < 0 ? `${a}:${b}` : `${b}:${a}`;
  }

  private inKanto(lat: number, lon: number): boolean {
    return lat >= KANTO_BUFFER.minLat && lat <= KANTO_BUFFER.maxLat &&
      lon >= KANTO_BUFFER.minLon && lon <= KANTO_BUFFER.maxLon;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
  }
}
