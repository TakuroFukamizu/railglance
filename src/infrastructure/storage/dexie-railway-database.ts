import Dexie, { Table } from 'dexie';
import { DatasetMetadata, RailwayLine, Station, TrackSegment } from '../../domain/models/railway';
import { RailwayDatabaseReader } from '../../domain/railway/map-matcher';
import { StationDatabaseReader } from '../../domain/railway/journey-state-estimator';
import { haversineDistance } from '../../domain/geo/distance';

import sampleLines from '../../data/sample/lines.json';
import sampleStations from '../../data/sample/stations.json';
import sampleTrackSegments from '../../data/sample/track-segments.json';
import sampleMetadata from '../../data/sample/metadata.json';

export type DatasetSyncStatus = {
  status: 'LOCAL_SAMPLE' | 'SYNCING' | 'READY_R2' | 'ERROR';
  version?: string;
  baseUrl?: string;
  totalLines?: number;
  totalStations?: number;
  errorMessage?: string;
};

export class DexieRailwayDatabase extends Dexie implements RailwayDatabaseReader, StationDatabaseReader {
  lines!: Table<RailwayLine, string>;
  stations!: Table<Station, string>;
  trackSegments!: Table<TrackSegment, string>;
  datasetMetadata!: Table<DatasetMetadata & { id: string }, string>;

  private syncStatus: DatasetSyncStatus = {
    status: 'LOCAL_SAMPLE',
    version: sampleMetadata.version,
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

    // Access Vite environment variables safely
    const envBaseUrl = (import.meta as any).env?.VITE_RAILWAY_DATA_BASE_URL;
    const baseUrl = typeof envBaseUrl === 'string' && envBaseUrl.trim().length > 0 ? envBaseUrl.trim() : undefined;

    if (baseUrl) {
      console.log('[CDN Tile Sync] VITE_RAILWAY_DATA_BASE_URL detected:', baseUrl);
      this.syncRemoteDataset(baseUrl).catch((err) => {
        console.warn('[CDN Tile Sync Error]:', err);
        this.syncStatus = {
          status: 'ERROR',
          baseUrl,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      });
    } else {
      console.log('[CDN Tile Sync] No VITE_RAILWAY_DATA_BASE_URL provided. Using local sample dataset.');
      this.syncStatus = {
        status: 'LOCAL_SAMPLE',
        version: sampleMetadata.version,
        totalLines: await this.lines.count(),
        totalStations: await this.stations.count(),
      };
    }
  }

  public async syncRemoteDataset(baseUrl: string): Promise<void> {
    const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
    this.syncStatus = {
      status: 'SYNCING',
      baseUrl: cleanBaseUrl,
      version: 'Fetching...',
    };

    try {
      // 1. Fetch latest pointer
      const latestRes = await fetch(`${cleanBaseUrl}/datasets/latest.json`, { mode: 'cors' });
      if (!latestRes.ok) throw new Error(`HTTP ${latestRes.status} on latest.json`);
      const latestInfo = await latestRes.json();

      // 2. Fetch manifest
      const manifestUrl = `${cleanBaseUrl}${latestInfo.manifestUrl}`;
      const manifestRes = await fetch(manifestUrl, { mode: 'cors' });
      if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status} on manifest.json`);
      const manifest = await manifestRes.json();

      // 3. Fetch coverage-report for dataset items
      const reportUrl = manifestUrl.replace('/manifest.json', '/coverage-report.json');
      const reportRes = await fetch(reportUrl, { mode: 'cors' });

      let remoteLines: RailwayLine[] = [];

      if (reportRes.ok) {
        const report = await reportRes.json();
        if (report.linesDetail) {
          remoteLines = report.linesDetail.map((l: any) => ({
            id: l.lineId,
            operatorId: l.operatorName,
            operatorName: l.operatorName,
            name: l.lineName,
          }));
        }
      }

      // If remote lines successfully loaded, populate DB
      if (remoteLines.length > 0) {
        await this.lines.clear();
        await this.lines.bulkPut(remoteLines);
      }

      const lineCount = await this.lines.count();
      const stationCount = await this.stations.count();

      console.log(`[CDN Tile Sync] Successfully connected & synced with ${cleanBaseUrl} (Version ${manifest.version})`);

      this.syncStatus = {
        status: 'READY_R2',
        baseUrl: cleanBaseUrl,
        version: manifest.version,
        totalLines: manifest.totalLines ?? lineCount,
        totalStations: manifest.totalStations ?? stationCount,
      };
    } catch (err) {
      console.warn('[CDN Tile Sync Exception]:', err);
      this.syncStatus = {
        status: 'ERROR',
        baseUrl: cleanBaseUrl,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async findSegmentsNear(
    latitude: number,
    longitude: number,
    radiusMeters: number
  ): Promise<TrackSegment[]> {
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
