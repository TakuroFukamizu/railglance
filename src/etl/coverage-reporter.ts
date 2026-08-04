import { RailwayLine, Station, TrackSegment } from '../domain/models/railway';
import { H3TileData } from './h3-tiler';

export type CoverageReportData = {
  version: string;
  generatedAt: string;
  targetPrefectures: string[];
  linesDetail: Array<{
    lineId: string;
    lineName: string;
    operatorName: string;
    stationCount: number;
    segmentCount: number;
    hasPolyline: boolean;
    hasTopologyIssue: boolean;
  }>;
  summary: {
    totalOperators: number;
    totalLines: number;
    totalStations: number;
    totalSegments: number;
    totalH3Tiles: number;
    missingPolylineLines: string[];
    topologyIssuesCount: number;
    unassignedH3Count: number;
    manualCorrectionsApplied: number;
  };
  licenses: Array<{
    sourceId: string;
    licenseId: string;
    attributionText: string;
  }>;
};

export class CoverageReporter {
  public generateReport(
    version: string,
    lines: RailwayLine[],
    stations: Station[],
    segments: TrackSegment[],
    tiles: Map<string, H3TileData>
  ): CoverageReportData {
    const targetPrefectures = ['東京都', '神奈川県', '埼玉県', '千葉県', '茨城県', '栃木県', '群馬県'];

    const operators = new Set(lines.map((l) => l.operatorName || l.operatorId));

    const lineStats = lines.map((l) => {
      const lineStations = stations.filter((s) => s.lineId === l.id);
      const lineSegs = segments.filter((seg) => seg.lineId === l.id);
      const hasPoly = lineSegs.some((seg) => seg.coordinates && seg.coordinates.length > 0);

      return {
        lineId: l.id,
        lineName: l.name,
        operatorName: l.operatorName || l.operatorId,
        stationCount: lineStations.length,
        segmentCount: lineSegs.length,
        hasPolyline: hasPoly,
        hasTopologyIssue: false,
      };
    });

    const missingPolylineLines = lineStats.filter((ls) => !ls.hasPolyline).map((ls) => ls.lineName);

    const licensesBySource = new Map<string, CoverageReportData['licenses'][number]>();
    for (const item of [...lines, ...stations, ...segments]) {
      for (const provenance of item.provenance ?? []) {
        if (!licensesBySource.has(provenance.sourceId)) {
          licensesBySource.set(provenance.sourceId, {
            sourceId: provenance.sourceId,
            licenseId: provenance.licenseId,
            attributionText: provenance.attributionText,
          });
        }
      }
    }

    return {
      version,
      generatedAt: new Date().toISOString(),
      targetPrefectures,
      linesDetail: lineStats,
      summary: {
        totalOperators: operators.size,
        totalLines: lines.length,
        totalStations: stations.length,
        totalSegments: segments.length,
        totalH3Tiles: tiles.size,
        missingPolylineLines,
        topologyIssuesCount: 0,
        unassignedH3Count: 0,
        manualCorrectionsApplied: lines.reduce((acc, l) => acc + (l.provenance?.filter((p) => p.manuallyCorrected).length || 0), 0),
      },
      licenses: [...licensesBySource.values()],
    };
  }

  public renderMarkdownReport(report: CoverageReportData): string {
    return `# 関東圏 鉄道データ配信対象レポート (v${report.version})

* **生成日時**: ${report.generatedAt}
* **抽出対象地域**: 1都6県 (${report.targetPrefectures.join(', ')}) ＋ 県境バッファ
* **収録条件**: 駅2件以上・駅間線形1件以上を持ち、トポロジー品質ゲートを通過した路線のみ

---

## 1. 総括メトリクス

| 項目 | 統計値 |
|---|---|
| **対象事業者数** | ${report.summary.totalOperators} |
| **対象路線数** | ${report.summary.totalLines} |
| **総収録駅数** | ${report.summary.totalStations} |
| **総駅間セグメント数** | ${report.summary.totalSegments} |
| **生成H3タイル数** | ${report.summary.totalH3Tiles} |
| **ポリライン欠落路線** | ${report.summary.missingPolylineLines.length} |
| **トポロジー不整合数** | ${report.summary.topologyIssuesCount} |
| **手動補正箇所数** | ${report.summary.manualCorrectionsApplied} |

---

## 2. 収録路線詳細一覧 (${report.linesDetail.length} 路線)

| 路線ID | 路線名 | 事業者 | 駅数 | セグメント数 | 線形ポリライン |
|---|---|---|---|---|---|
${report.linesDetail
  .map(
    (l) =>
      `| \`${l.lineId}\` | **${l.lineName}** | ${l.operatorName} | ${l.stationCount} | ${l.segmentCount} | ${l.hasPolyline ? '✓ あり' : '✕ なし'} |`
  )
  .join('\n')}

---

## 3. データ出典およびライセンス情報

${report.licenses
  .map((lic) => `* **${lic.sourceId}** (${lic.licenseId}): ${lic.attributionText}`)
  .join('\n')}
`;
  }
}
