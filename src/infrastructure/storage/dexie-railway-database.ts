import Dexie, { Table } from 'dexie';
import { DatasetMetadata, RailwayLine, Station, TrackSegment } from '../../domain/models/railway';
import { RailwayDatabaseReader } from '../../domain/railway/map-matcher';
import { StationDatabaseReader } from '../../domain/railway/journey-state-estimator';
import { haversineDistance } from '../../domain/geo/distance';

import sampleLines from '../../data/sample/lines.json';
import sampleStations from '../../data/sample/stations.json';
import sampleTrackSegments from '../../data/sample/track-segments.json';
import sampleMetadata from '../../data/sample/metadata.json';

export class DexieRailwayDatabase extends Dexie implements RailwayDatabaseReader, StationDatabaseReader {
  lines!: Table<RailwayLine, string>;
  stations!: Table<Station, string>;
  trackSegments!: Table<TrackSegment, string>;
  datasetMetadata!: Table<DatasetMetadata & { id: string }, string>;

  constructor() {
    super('RailGlanceDB');
    this.version(1).stores({
      lines: 'id, operatorId, name',
      stations: 'id, lineId, sequence',
      trackSegments: 'id, lineId, fromStationId, toStationId',
      datasetMetadata: 'id, version',
    });
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
