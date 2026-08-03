import { RailwayLine, Station, TrackSegment } from '../../domain/models/railway';
import { SourceLicenseMetadata } from '../../domain/models/provenance';

export type RawRailwayDataset = {
  lines: RailwayLine[];
  stations: Station[];
  segments: TrackSegment[];
};

export interface RailwaySourceAdapter {
  sourceId: string;
  load(): Promise<RawRailwayDataset>;
  getLicenseMetadata(): Promise<SourceLicenseMetadata>;
}
