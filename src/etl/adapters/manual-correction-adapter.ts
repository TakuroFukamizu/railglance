import { RailwaySourceAdapter, RawRailwayDataset } from './source-adapter';
import { SourceLicenseMetadata, DataProvenance } from '../../domain/models/provenance';
import lineAliases from '../../../data/corrections/line-aliases.json';
import excludedSegments from '../../../data/corrections/excluded-segments.json';

export class ManualCorrectionAdapter implements RailwaySourceAdapter {
  public sourceId = 'manual-corrections';

  public async getLicenseMetadata(): Promise<SourceLicenseMetadata> {
    return {
      licenseId: 'MIT',
      name: 'RailGlance Manual Overrides',
      url: 'https://github.com/TakuroFukamizu/railglance',
      attributionRequired: false,
      attributionText: 'RailGlance Manual Curations',
      redistributionAllowed: true,
    };
  }

  public async load(): Promise<RawRailwayDataset> {
    return {
      lines: [],
      stations: [],
      segments: [],
    };
  }

  public applyCorrections(dataset: RawRailwayDataset): RawRailwayDataset {
    const provenance: DataProvenance = {
      sourceId: this.sourceId,
      acquiredAt: new Date().toISOString(),
      licenseId: 'MIT',
      attributionText: 'RailGlance Manual Curations',
      manuallyCorrected: true,
    };

    const excludedSet = new Set<string>(excludedSegments.excludedSegmentIds || []);

    // Filter excluded segments
    const filteredSegments = dataset.segments
      .filter((seg) => !excludedSet.has(seg.id))
      .map((seg) => ({
        ...seg,
        provenance: [...(seg.provenance || []), provenance],
      }));

    // Apply Line Aliases
    const aliasMap = (lineAliases.aliases || {}) as Record<string, string>;
    const updatedLines = dataset.lines.map((line) => {
      if (aliasMap[line.name]) {
        return {
          ...line,
          name: aliasMap[line.name],
          provenance: [...(line.provenance || []), provenance],
        };
      }
      return line;
    });

    return {
      lines: updatedLines,
      stations: dataset.stations,
      segments: filteredSegments,
    };
  }
}
