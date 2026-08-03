import Dexie, { Table } from 'dexie';
import { DatasetMetadata, RailwayLine, Station, TrackSegment } from '../../domain/models/railway';
import { RailwayDatabaseReader } from '../../domain/railway/map-matcher';
import { StationDatabaseReader } from '../../domain/railway/journey-state-estimator';
import { haversineDistance } from '../../domain/geo/distance';
import { H3Tiler, H3TileData } from '../../etl/h3-tiler';

import sampleLines from '../../data/sample/lines.json';
import sampleStations from '../../data/sample/stations.json';
import sampleTrackSegments from '../../data/sample/track-segments.json';
import sampleMetadata from '../../data/sample/metadata.json';

export type DatasetSyncStatus = {
  status: 'LOCAL_SAMPLE' | 'SYNCING' | 'READY_R2' | 'ERROR';
  version?: string;
  baseUrl?: string;
  currentCellId?: string;
  loadedTileCount?: number;
  totalLines?: number;
  totalStations?: number;
  errorMessage?: string;
};

export class DexieRailwayDatabase extends Dexie implements RailwayDatabaseReader, StationDatabaseReader {
  lines!: Table<RailwayLine, string>;
  stations!: Table<Station, string>;
  trackSegments!: Table<TrackSegment, string>;
  datasetMetadata!: Table<DatasetMetadata & { id: string }, string>;

  private h3Tiler = new H3Tiler(6);
  private loadedCells = new Set<string>();
  private activeBaseUrl?: string;
  private activeVersion?: string;

  private syncStatus: DatasetSyncStatus = {
    status: 'LOCAL_SAMPLE',
    version: sampleMetadata.version,
    loadedTileCount: 0,
    totalLines: sampleLines.length,
    totalStations: sampleStations.length,
  };

  constructor() {
    super('RailGlanceDB');
    this.version(1).stores({
      lines: 'id, operatorId, name',
      stations: 'id, lineId, sequence',
      trackSegments: 'id, lineId, fromStationId, toStationId',
      datasetMetadata: 'id, version',
    });
  }

  public getSyncStatus(): DatasetSyncStatus {
    return { ...this.syncStatus };
  }

  public async initialize(): Promise<void> {
    await this.open();
    const existingMeta = await this.datasetMetadata.get('current');

    if (!existingMeta || existingMeta.version !== sampleMetadata.version) {
      await this.lines.clear();
      await this.stations.clear();
      await this.trackSegments.clear();

      await this.lines.bulkAdd(sampleLines as RailwayLine[]);
      await this.stations.bulkAdd(sampleStations as Station[]);
      await this.trackSegments.bulkAdd(sampleTrackSegments as TrackSegment[]);
      await this.datasetMetadata.put({
        id: 'current',
        ...(sampleMetadata as DatasetMetadata),
      });
    }

    const envBaseUrl = (import.meta as any).env?.VITE_RAILWAY_DATA_BASE_URL;
    const baseUrl = typeof envBaseUrl === 'string' && envBaseUrl.trim().length > 0 ? envBaseUrl.trim() : undefined;

    if (baseUrl) {
      this.activeBaseUrl = baseUrl.replace(/\/+$/, '');
      console.log('[H3 Tile Streamer] VITE_RAILWAY_DATA_BASE_URL detected:', this.activeBaseUrl);
      this.connectRemoteManifest(this.activeBaseUrl).catch((err) => {
        console.warn('[H3 Tile Streamer Error]:', err);
        this.syncStatus = {
          status: 'ERROR',
          baseUrl: this.activeBaseUrl,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      });
    } else {
      console.log('[H3 Tile Streamer] No VITE_RAILWAY_DATA_BASE_URL provided. Using local sample dataset.');
      this.syncStatus = {
        status: 'LOCAL_SAMPLE',
        version: sampleMetadata.version,
        loadedTileCount: 0,
        totalLines: await this.lines.count(),
        totalStations: await this.stations.count(),
      };
    }
  }

  /**
   * Connects to remote R2 dataset manifest to verify version pointer (small KB payload).
   */
  public async connectRemoteManifest(baseUrl: string): Promise<void> {
    this.syncStatus = {
      status: 'SYNCING',
      baseUrl,
      version: 'Checking Manifest...',
    };

    try {
      const latestRes = await fetch(`${baseUrl}/datasets/latest.json`, { mode: 'cors' });
      if (!latestRes.ok) throw new Error(`HTTP ${latestRes.status} on latest.json`);
      const latestInfo = await latestRes.json();
      this.activeVersion = latestInfo.version;

      const manifestUrl = `${baseUrl}${latestInfo.manifestUrl}`;
      const manifestRes = await fetch(manifestUrl, { mode: 'cors' });
      if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status} on manifest.json`);
      const manifest = await manifestRes.json();

      console.log(`[H3 Tile Streamer] Manifest connected! Dataset Version: ${manifest.version}, Total Tiles Available: ${manifest.totalTiles}`);

      this.syncStatus = {
        status: 'READY_R2',
        baseUrl,
        version: manifest.version,
        loadedTileCount: this.loadedCells.size,
        totalLines: await this.lines.count(),
        totalStations: await this.stations.count(),
      };
    } catch (err) {
      console.warn('[H3 Tile Streamer Manifest Error]:', err);
      this.syncStatus = {
        status: 'ERROR',
        baseUrl,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * On-Demand H3 Tile Streamer: Fetches ONLY the H3 tiles corresponding to the current GPS position.
   */
  public async ensureTilesLoadedForPosition(latitude: number, longitude: number): Promise<void> {
    if (!this.activeBaseUrl || !this.activeVersion) return;

    const cellId = this.h3Tiler.latLonToCellId(latitude, longitude);
    this.syncStatus.currentCellId = cellId;

    if (this.loadedCells.has(cellId)) return;

    console.log(`[H3 Tile Streamer] Current position (${latitude.toFixed(4)}, ${longitude.toFixed(4)}) maps to H3 Cell: ${cellId}. Fetching tile on-demand...`);

    try {
      const tileUrl = `${this.activeBaseUrl}/datasets/v${this.activeVersion}/h3/6/${cellId}.json`;
      const res = await fetch(tileUrl, { mode: 'cors' });

      if (res.ok) {
        const tileData: H3TileData = await res.json();

        // Import ONLY the lines, stations, and segments present in this specific spatial H3 tile
        if (tileData.lines && tileData.lines.length > 0) {
          await this.lines.bulkPut(tileData.lines);
        }
        if (tileData.stations && tileData.stations.length > 0) {
          await this.stations.bulkPut(tileData.stations);
        }
        if (tileData.segments && tileData.segments.length > 0) {
          await this.trackSegments.bulkPut(tileData.segments);
        }

        this.loadedCells.add(cellId);
        console.log(`[H3 Tile Streamer] Successfully loaded & cached tile ${cellId} (${tileData.lines.length} lines, ${tileData.stations.length} stations)`);
      } else if (res.status === 404) {
        // Tile not present in dataset (e.g. non-railway area or outside coverage boundary)
        this.loadedCells.add(cellId);
      }

      this.syncStatus = {
        ...this.syncStatus,
        status: 'READY_R2',
        loadedTileCount: this.loadedCells.size,
        totalLines: await this.lines.count(),
        totalStations: await this.stations.count(),
      };
    } catch (err) {
      console.warn(`[H3 Tile Streamer Fetch Error for ${cellId}]:`, err);
    }
  }

  public async findSegmentsNear(
    latitude: number,
    longitude: number,
    radiusMeters: number
  ): Promise<TrackSegment[]> {
    // Dynamically trigger on-demand spatial tile fetch for current GPS location
    await this.ensureTilesLoadedForPosition(latitude, longitude);

    const allSegments = await this.trackSegments.toArray();
    // Filter segments whose coordinates pass near (latitude, longitude)
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
    return this.lines.get(lineId);
  }

  public async getStationsByLine(lineId: string): Promise<Station[]> {
    return this.stations.where('lineId').equals(lineId).sortBy('sequence');
  }

  public async getStation(stationId: string): Promise<Station | undefined> {
    return this.stations.get(stationId);
  }
}
