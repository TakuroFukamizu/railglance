import { RailwayLine, RailwayRoute, Station, TrackSegment } from '../models/railway';

export type RailwayDataState =
  | 'bundled'
  | 'cached'
  | 'cloud'
  | 'downloading'
  | 'unavailable'
  | 'error';

export interface RailwayCoverageResult {
  state: RailwayDataState;
  cellId?: string;
  loadedTileCount: number;
  errorMessage?: string;
}

export interface RailwayDataRepository {
  ensureCoverageAround(
    latitude: number,
    longitude: number
  ): Promise<RailwayCoverageResult>;

  findSegmentsNear(
    latitude: number,
    longitude: number,
    radiusMeters: number
  ): Promise<TrackSegment[]>;

  getLine(
    lineId: string
  ): Promise<RailwayLine | undefined>;

  getRoute(
    routeId: string
  ): Promise<RailwayRoute | undefined>;

  getStation(
    stationId: string
  ): Promise<Station | undefined>;

  getStationsByLine(
    lineId: string
  ): Promise<Station[]>;

  getSegmentsByRoute(
    routeId: string
  ): Promise<TrackSegment[]>;

  getDataState(): RailwayDataState;
}
