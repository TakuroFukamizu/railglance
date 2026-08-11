import Dexie, { Table } from 'dexie';
import { DatasetMetadata, RailwayLine, RailwayRoute, Station, TrackSegment } from '../../domain/models/railway';
import { RailwayCoverageResult, RailwayDataRepository, RailwayDataState } from '../../domain/railway/repository';
import { haversineDistance } from '../../domain/geo/distance';
import { H3Tiler, H3TileData } from '../../etl/h3-tiler';
import {
  parseH3TileData,
  parseLatestDatasetPointer,
  parseRailwayDatasetManifest,
  RAILWAY_DATASET_SCHEMA_VERSION,
} from './railway-dataset-schema';

import sampleLines from '../../data/sample/lines.json';
import sampleStations from '../../data/sample/stations.json';
import sampleTrackSegments from '../../data/sample/track-segments.json';
import sampleMetadata from '../../data/sample/metadata.json';

export type DatasetSyncStatus = {
  status: RailwayDataState;
  version?: string;
  schemaVersion?: string;
  baseUrl?: string;
  currentCellId?: string;
  loadedTileCount?: number;
  totalLines?: number;
  totalStations?: number;
  errorMessage?: string;
};

export type DexieRailwayDatabaseOptions = {
  databaseName?: string;
  remoteBaseUrl?: string | null;
};

type Versioned<T> = T & { datasetVersion: string };
type LoadedRemoteTile = { datasetVersion: string; cellId: string };

export class DexieRailwayDatabase extends Dexie implements RailwayDataRepository {
  lines!: Table<RailwayLine, string>;
  routes!: Table<RailwayRoute, string>;
  stations!: Table<Station, string>;
  trackSegments!: Table<TrackSegment, string>;
  datasetMetadata!: Table<DatasetMetadata & { id: string; activeRemoteVersion?: string }, string>;
  remoteLines!: Table<Versioned<RailwayLine>, [string, string]>;
  remoteRoutes!: Table<Versioned<RailwayRoute>, [string, string]>;
  remoteStations!: Table<Versioned<Station>, [string, string]>;
  remoteTrackSegments!: Table<Versioned<TrackSegment>, [string, string]>;
  remoteTiles!: Table<LoadedRemoteTile, [string, string]>;

  private h3Tiler = new H3Tiler(6);
  private loadedCells = new Set<string>();
  private tileRequests = new Map<string, Promise<void>>();
  private activeBaseUrl?: string;
  private activeVersion?: string;
  private currentState: RailwayDataState = 'bundled';

  private syncStatus: DatasetSyncStatus = {
    status: 'bundled',
    version: sampleMetadata.version,
    schemaVersion: RAILWAY_DATASET_SCHEMA_VERSION,
    loadedTileCount: 0,
    totalLines: sampleLines.length,
    totalStations: sampleStations.length,
  };

  constructor(private options: DexieRailwayDatabaseOptions = {}) {
    super(options.databaseName ?? 'RailGlanceDB');
    this.version(2).stores({
      lines: 'id, operatorId, name',
      routes: 'id, lineId, direction',
      stations: 'id, lineId, sequence',
      trackSegments: 'id, lineId, routeId, fromStationId, toStationId',
      datasetMetadata: 'id, version, schemaVersion',
    });
    this.version(3).stores({
      lines: 'id, operatorId, name',
      routes: 'id, lineId, direction',
      stations: 'id, lineId, sequence',
      trackSegments: 'id, lineId, routeId, fromStationId, toStationId',
      datasetMetadata: 'id, version, schemaVersion, activeRemoteVersion',
    });
    this.version(4).stores({
      lines: 'id, operatorId, name',
      routes: 'id, lineId, direction',
      stations: 'id, lineId, sequence',
      trackSegments: 'id, lineId, routeId, fromStationId, toStationId',
      datasetMetadata: 'id, version, schemaVersion, activeRemoteVersion',
      remoteLines: '[datasetVersion+id], datasetVersion, id, operatorId, name',
      remoteRoutes: '[datasetVersion+id], datasetVersion, id, lineId, direction',
      remoteStations: '[datasetVersion+id], datasetVersion, id, lineId, sequence',
      remoteTrackSegments: '[datasetVersion+id], datasetVersion, id, lineId, routeId, fromStationId, toStationId',
      remoteTiles: '[datasetVersion+cellId], datasetVersion, cellId',
    });
  }

  public getDataState(): RailwayDataState {
    return this.currentState;
  }

  public getSyncStatus(): DatasetSyncStatus {
    return { ...this.syncStatus };
  }

  public async initialize(): Promise<void> {
    await this.open();
    const existingMeta = await this.datasetMetadata.get('current');

    // Migration / Refresh check for Schema v1.1.0
    const targetSchemaVersion = RAILWAY_DATASET_SCHEMA_VERSION;
    if (!existingMeta || existingMeta.schemaVersion !== targetSchemaVersion) {
      console.log(`[DexieRailwayDatabase] Migrating IndexedDB schema to ${targetSchemaVersion}...`);
      await this.resetToBundledDataset();
    }

    // Connect remote CDN Tile Streamer if environment URL exists
    const envBaseUrl = this.options.remoteBaseUrl === undefined
      ? (import.meta as any).env?.VITE_RAILWAY_DATA_BASE_URL
      : this.options.remoteBaseUrl;
    const baseUrl = typeof envBaseUrl === 'string' && envBaseUrl.trim().length > 0 ? envBaseUrl.trim() : undefined;

    if (baseUrl) {
      this.activeBaseUrl = baseUrl.replace(/\/+$/, '');
      console.log('[H3 Tile Streamer] VITE_RAILWAY_DATA_BASE_URL detected:', this.activeBaseUrl);
      this.connectRemoteManifest(this.activeBaseUrl).catch((err) => {
        console.warn('[H3 Tile Streamer Error]:', err);
        this.currentState = 'bundled';
        this.syncStatus = {
          status: 'bundled',
          baseUrl: this.activeBaseUrl,
          version: sampleMetadata.version,
          schemaVersion: targetSchemaVersion,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      });
    } else {
      this.currentState = 'bundled';
      this.syncStatus = {
        status: 'bundled',
        version: sampleMetadata.version,
        schemaVersion: targetSchemaVersion,
        loadedTileCount: 0,
        totalLines: await this.lines.count(),
        totalStations: await this.stations.count(),
      };
    }
  }

  public async connectRemoteManifest(baseUrl: string): Promise<void> {
    this.activeBaseUrl = baseUrl.replace(/\/+$/, '');
    baseUrl = this.activeBaseUrl;
    this.currentState = 'downloading';
    this.syncStatus = {
      status: 'downloading',
      baseUrl,
      version: 'Checking Manifest...',
    };

    try {
      const latestRes = await fetch(`${baseUrl}/datasets/latest.json`, { mode: 'cors' });
      if (!latestRes.ok) throw new Error(`HTTP ${latestRes.status} on latest.json`);
      const latestInfo = parseLatestDatasetPointer(await latestRes.json());
      this.activeVersion = latestInfo.version;

      const manifestUrl = `${baseUrl}${latestInfo.manifestUrl}`;
      const manifestRes = await fetch(manifestUrl, { mode: 'cors' });
      if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status} on manifest.json`);
      const manifest = parseRailwayDatasetManifest(await manifestRes.json());
      if (manifest.version !== latestInfo.version || manifest.schemaVersion !== latestInfo.schemaVersion) {
        throw new Error('latest.json and manifest.json identify different datasets');
      }

      await this.activateRemoteDatasetVersion(manifest.version);

      console.log(`[H3 Tile Streamer] Manifest connected! Dataset Version: ${manifest.version}, Schema: ${manifest.schemaVersion}`);

      this.currentState = this.loadedCells.size > 0 ? 'cloud' : 'cached';
      this.syncStatus = {
        status: this.currentState,
        baseUrl,
        version: manifest.version,
        schemaVersion: manifest.schemaVersion,
        loadedTileCount: this.loadedCells.size,
        totalLines: manifest.totalLines,
        totalStations: manifest.totalStations,
      };
    } catch (err) {
      console.warn('[H3 Tile Streamer Manifest Error]:', err);
      this.activeVersion = undefined;
      this.currentState = 'bundled';
      this.syncStatus = {
        status: 'bundled',
        baseUrl,
        version: sampleMetadata.version,
        schemaVersion: RAILWAY_DATASET_SCHEMA_VERSION,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
      throw err;
    }
  }

  public async ensureCoverageAround(latitude: number, longitude: number): Promise<RailwayCoverageResult> {
    if (!this.activeBaseUrl || !this.activeVersion) {
      return {
        state: this.currentState,
        loadedTileCount: this.loadedCells.size,
      };
    }

    const cellId = this.h3Tiler.latLonToCellId(latitude, longitude);
    this.syncStatus.currentCellId = cellId;

    try {
      const coverageCells = this.h3Tiler.coverageCellIds(latitude, longitude, 1);
      await Promise.all(coverageCells.map((coverageCellId) => this.loadTile(coverageCellId)));

      this.syncStatus = {
        ...this.syncStatus,
        status: this.currentState,
        loadedTileCount: this.loadedCells.size,
      };

      return {
        state: this.currentState,
        cellId,
        loadedTileCount: this.loadedCells.size,
      };
    } catch (err) {
      console.warn(`[H3 Tile Streamer Error ${cellId}]:`, err);
      return {
        state: 'error',
        cellId,
        loadedTileCount: this.loadedCells.size,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async loadTile(cellId: string): Promise<void> {
    if (this.loadedCells.has(cellId)) return;
    const requestVersion = this.activeVersion;
    if (!requestVersion || !this.activeBaseUrl) return;
    const requestKey = `${requestVersion}:${cellId}`;
    const pending = this.tileRequests.get(requestKey);
    if (pending) return pending;

    const request = (async () => {
      const tileUrl = `${this.activeBaseUrl}/datasets/v${requestVersion}/h3/6/${cellId}.json`;
      const res = await fetch(tileUrl, { mode: 'cors' });
      if (res.status === 404) {
        if (this.activeVersion === requestVersion) this.loadedCells.add(cellId);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} on H3 tile ${cellId}`);

      const tileData: H3TileData = parseH3TileData(await res.json(), cellId);
      if (this.activeVersion !== requestVersion) return;
      await this.transaction(
        'rw',
        this.remoteLines,
        this.remoteRoutes,
        this.remoteStations,
        this.remoteTrackSegments,
        this.remoteTiles,
        async () => {
          if (this.activeVersion !== requestVersion) return;
          if (tileData.lines.length > 0) {
            await this.remoteLines.bulkPut(tileData.lines.map((item) => ({ ...item, datasetVersion: requestVersion })));
          }
          if (tileData.routes.length > 0) {
            await this.remoteRoutes.bulkPut(tileData.routes.map((item) => ({ ...item, datasetVersion: requestVersion })));
          }
          if (tileData.stations.length > 0) {
            await this.remoteStations.bulkPut(tileData.stations.map((item) => ({ ...item, datasetVersion: requestVersion })));
          }
          if (tileData.segments.length > 0) {
            await this.remoteTrackSegments.bulkPut(
              tileData.segments.map((item) => ({ ...item, datasetVersion: requestVersion }))
            );
          }
          await this.remoteTiles.put({ datasetVersion: requestVersion, cellId });
        }
      );
      if (this.activeVersion === requestVersion) {
        this.loadedCells.add(cellId);
        this.currentState = 'cloud';
      }
    })().finally(() => this.tileRequests.delete(requestKey));

    this.tileRequests.set(requestKey, request);
    return request;
  }

  private async resetToBundledDataset(): Promise<void> {
    const upgradedSegments: TrackSegment[] = (sampleTrackSegments as TrackSegment[]).map((segment, index) => ({
      ...segment,
      startOffsetMeters: segment.startOffsetMeters ?? index * 2000,
      routeId: segment.routeId ?? `route-${segment.lineId}-main`,
    }));

    await this.transaction(
      'rw',
      this.lines,
      this.routes,
      this.stations,
      this.trackSegments,
      this.datasetMetadata,
      async () => {
        await Promise.all([
          this.lines.clear(),
          this.routes.clear(),
          this.stations.clear(),
          this.trackSegments.clear(),
        ]);
        await this.lines.bulkPut(sampleLines as RailwayLine[]);
        await this.stations.bulkPut(sampleStations as Station[]);
        await this.trackSegments.bulkPut(upgradedSegments);
        await this.datasetMetadata.put({
          id: 'current',
          ...(sampleMetadata as DatasetMetadata),
          schemaVersion: RAILWAY_DATASET_SCHEMA_VERSION,
        });
      }
    );
  }

  private async activateRemoteDatasetVersion(version: string): Promise<void> {
    const metadata = await this.datasetMetadata.get('current');
    if (metadata?.activeRemoteVersion !== version) {
      await this.transaction('rw', this.datasetMetadata, async () => {
        await this.datasetMetadata.put({
          ...(metadata ?? {
            id: 'current',
            ...(sampleMetadata as DatasetMetadata),
            schemaVersion: RAILWAY_DATASET_SCHEMA_VERSION,
          }),
          activeRemoteVersion: version,
        });
      });
    }

    this.loadedCells = new Set(
      (await this.remoteTiles.where('datasetVersion').equals(version).toArray()).map((tile) => tile.cellId)
    );
    await this.deleteInactiveRemoteVersions(version);
  }

  private async deleteInactiveRemoteVersions(activeVersion: string): Promise<void> {
    await this.transaction(
      'rw',
      this.remoteLines,
      this.remoteRoutes,
      this.remoteStations,
      this.remoteTrackSegments,
      this.remoteTiles,
      async () => {
        for (const table of [
          this.remoteLines,
          this.remoteRoutes,
          this.remoteStations,
          this.remoteTrackSegments,
          this.remoteTiles,
        ]) {
          await table.where('datasetVersion').notEqual(activeVersion).delete();
        }
      }
    );
  }

  public async findSegmentsNear(
    latitude: number,
    longitude: number,
    radiusMeters: number
  ): Promise<TrackSegment[]> {
    const bundledSegments = await this.trackSegments.toArray();
    const remoteSegments = this.activeVersion
      ? await this.remoteTrackSegments.where('datasetVersion').equals(this.activeVersion).toArray()
      : [];
    const allSegments = this.mergeById(bundledSegments, remoteSegments);
    return allSegments.filter((seg) => {
      for (const [lat, lon] of seg.coordinates) {
        if (haversineDistance(latitude, longitude, lat, lon) <= radiusMeters * 1.5) {
          return true;
        }
      }
      return false;
    });
  }

  public async getLine(lineId: string): Promise<RailwayLine | undefined> {
    if (this.activeVersion) {
      const remote = await this.remoteLines.get([this.activeVersion, lineId]);
      if (remote) return remote;
    }
    return this.lines.get(lineId);
  }

  public async getRoute(routeId: string): Promise<RailwayRoute | undefined> {
    if (this.activeVersion) {
      const remote = await this.remoteRoutes.get([this.activeVersion, routeId]);
      if (remote) return remote;
    }
    return this.routes.get(routeId);
  }

  public async getStation(stationId: string): Promise<Station | undefined> {
    if (this.activeVersion) {
      const remote = await this.remoteStations.get([this.activeVersion, stationId]);
      if (remote) return remote;
    }
    return this.stations.get(stationId);
  }

  public async getStationsByLine(lineId: string): Promise<Station[]> {
    const bundled = await this.stations.where('lineId').equals(lineId).toArray();
    const remote = this.activeVersion
      ? await this.remoteStations
          .where('datasetVersion')
          .equals(this.activeVersion)
          .filter((station) => station.lineId === lineId)
          .toArray()
      : [];
    return this.mergeById(bundled, remote).sort((a, b) => a.sequence - b.sequence);
  }

  public async getSegmentsByRoute(routeId: string): Promise<TrackSegment[]> {
    const bundled = await this.trackSegments.where('routeId').equals(routeId).toArray();
    const remote = this.activeVersion
      ? await this.remoteTrackSegments
          .where('datasetVersion')
          .equals(this.activeVersion)
          .filter((segment) => segment.routeId === routeId)
          .toArray()
      : [];
    const segs = this.mergeById(bundled, remote);
    return segs.sort((a, b) => (a.startOffsetMeters ?? 0) - (b.startOffsetMeters ?? 0));
  }

  private mergeById<T extends { id: string }>(bundled: T[], remote: T[]): T[] {
    const merged = new Map(bundled.map((item) => [item.id, item]));
    for (const item of remote) merged.set(item.id, item);
    return [...merged.values()];
  }
}
