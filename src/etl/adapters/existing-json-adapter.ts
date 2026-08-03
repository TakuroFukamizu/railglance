import { RailwaySourceAdapter, RawRailwayDataset } from './source-adapter';
import { SourceLicenseMetadata, DataProvenance } from '../../domain/models/provenance';
import linesSample from '../../data/sample/lines.json';
import stationsSample from '../../data/sample/stations.json';
import segmentsSample from '../../data/sample/track-segments.json';

export class ExistingJsonRailwayAdapter implements RailwaySourceAdapter {
  public sourceId = 'railglance-existing-sample';

  public async getLicenseMetadata(): Promise<SourceLicenseMetadata> {
    return {
      licenseId: 'MIT',
      name: 'RailGlance Curated Sample Dataset',
      url: 'https://github.com/TakuroFukamizu/railglance',
      attributionRequired: false,
      attributionText: 'RailGlance Core Team',
      redistributionAllowed: true,
    };
  }

  public async load(): Promise<RawRailwayDataset> {
    const provenance: DataProvenance = {
      sourceId: this.sourceId,
      acquiredAt: new Date().toISOString(),
      licenseId: 'MIT',
      attributionText: 'RailGlance Core Team',
      manuallyCorrected: false,
    };

    const linesRaw = Array.isArray(linesSample) ? linesSample : (linesSample as any).lines || [];
    const stationsRaw = Array.isArray(stationsSample) ? stationsSample : (stationsSample as any).stations || [];
    const segmentsRaw = Array.isArray(segmentsSample) ? segmentsSample : (segmentsSample as any).segments || [];

    const lines = linesRaw.map((l: any) => ({
      ...l,
      provenance: [provenance],
    }));

    const stations = stationsRaw.map((s: any) => ({
      ...s,
      provenance: [provenance],
    }));

    const segments = segmentsRaw.map((seg: any) => ({
      ...seg,
      coordinates: seg.coordinates as Array<[number, number]>,
      provenance: [provenance],
    }));

    return {
      lines,
      stations,
      segments,
    };
  }
}
