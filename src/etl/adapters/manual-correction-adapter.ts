import { RailwaySourceAdapter, RawRailwayDataset } from './source-adapter';
import { SourceLicenseMetadata, DataProvenance } from '../../domain/models/provenance';
import { RailwayLine } from '../../domain/models/railway';
import lineAliases from '../../../data/corrections/line-aliases.json';
import excludedSegments from '../../../data/corrections/excluded-segments.json';
import lineDirections from '../../../data/corrections/line-directions.json';
import {
  LineDirectionCorrection,
  matchesLineDirection,
  resolveLineDirectionNames,
} from '../line-directions';

export type ManualCorrectionAdapterOptions = {
  /** 省略時は data/corrections/line-directions.json を使う。テストで差し替え可能。 */
  lineDirections?: LineDirectionCorrection[];
};

export class ManualCorrectionAdapter implements RailwaySourceAdapter {
  public sourceId = 'manual-corrections';

  private readonly lineDirections: LineDirectionCorrection[];

  constructor(options: ManualCorrectionAdapterOptions = {}) {
    this.lineDirections = options.lineDirections ?? (lineDirections.lineDirections as LineDirectionCorrection[]);
  }

  public matchesLineDirection(entry: LineDirectionCorrection, line: RailwayLine): boolean {
    return matchesLineDirection(entry, line);
  }

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
    const aliasedLines = dataset.lines.map((line) => {
      if (aliasMap[line.name]) {
        return {
          ...line,
          name: aliasMap[line.name],
          provenance: [...(line.provenance || []), provenance],
        };
      }
      return line;
    });

    // Apply Line Directions: 方向名を持たない路線(MLIT 由来)に、起点駅の位置から
    // 「上り」「下り」を振り分ける。手書きの方向名がある路線は上書きしない。
    const updatedLines = aliasedLines.map((line) => {
      if (line.directionAName || line.directionBName) return line;
      const entry = this.lineDirections.find((candidate) => matchesLineDirection(candidate, line));
      if (!entry) return line;
      const lineStations = dataset.stations.filter((station) => station.lineId === line.id);
      const names = resolveLineDirectionNames(entry, lineStations);
      if (!names) {
        console.warn(
          `[ManualCorrectionAdapter] Line ${line.id} (${line.name}) matched a direction entry but ` +
            `up terminal "${entry.upTerminalStation}" is not at an end of its station list; leaving direction names unset.`
        );
        return line;
      }
      return {
        ...line,
        ...names,
        provenance: [...(line.provenance || []), provenance],
      };
    });

    return {
      lines: updatedLines,
      stations: dataset.stations,
      segments: filteredSegments,
    };
  }
}
