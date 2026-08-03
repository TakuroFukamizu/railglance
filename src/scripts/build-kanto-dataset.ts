import * as fs from 'fs';
import * as path from 'path';
import { ExistingJsonRailwayAdapter } from '../etl/adapters/existing-json-adapter';
import { MlitRailwayAdapter } from '../etl/adapters/mlit-adapter';
import { ManualCorrectionAdapter } from '../etl/adapters/manual-correction-adapter';
import { TopologyBuilder } from '../etl/topology-builder';
import { H3Tiler } from '../etl/h3-tiler';
import { CoverageReporter } from '../etl/coverage-reporter';

export async function buildKantoDataset(version = '1.0.0'): Promise<void> {
  console.log(`[ETL] Starting Kanto Region Railway Dataset Build (v${version})...`);

  // 1. Load data from adapters
  const existingAdapter = new ExistingJsonRailwayAdapter();
  const mlitAdapter = new MlitRailwayAdapter();
  const manualAdapter = new ManualCorrectionAdapter();

  const existingData = await existingAdapter.load();
  const mlitData = await mlitAdapter.load();

  // Merge lines, stations, and segments avoiding duplicate IDs
  const lineMap = new Map();
  for (const l of [...existingData.lines, ...mlitData.lines]) {
    lineMap.set(l.id, l);
  }

  const stationMap = new Map();
  for (const s of [...existingData.stations, ...mlitData.stations]) {
    stationMap.set(s.id, s);
  }

  const segmentMap = new Map();
  for (const seg of [...existingData.segments, ...mlitData.segments]) {
    segmentMap.set(seg.id, seg);
  }

  const rawDataset = {
    lines: Array.from(lineMap.values()),
    stations: Array.from(stationMap.values()),
    segments: Array.from(segmentMap.values()),
  };

  // 2. Build Topology
  const topologyBuilder = new TopologyBuilder();
  const topologizedData = topologyBuilder.buildTopology(
    rawDataset.lines,
    rawDataset.stations,
    rawDataset.segments
  );

  // 3. Apply Manual Corrections
  const correctedData = manualAdapter.applyCorrections(topologizedData);

  // 4. Generate H3 Spatial Tiles
  const h3Tiler = new H3Tiler(6);
  const tiles = h3Tiler.generateTiles(
    correctedData.lines,
    correctedData.stations,
    correctedData.segments
  );

  // 5. Generate Coverage Report
  const coverageReporter = new CoverageReporter();
  const reportData = coverageReporter.generateReport(
    version,
    correctedData.lines,
    correctedData.stations,
    correctedData.segments,
    tiles
  );
  const markdownReport = coverageReporter.renderMarkdownReport(reportData);

  // 6. Write Output Files to dist/railway-dataset/v{version}/ and docs/
  const outDir = path.resolve(process.cwd(), `dist/railway-dataset/v${version}`);
  const h3Dir = path.join(outDir, 'h3', '6');
  fs.mkdirSync(h3Dir, { recursive: true });

  // Write Manifest
  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    area: 'Kanto 1 Metropolis & 6 Prefectures + County Boundary Buffers',
    totalLines: correctedData.lines.length,
    totalStations: correctedData.stations.length,
    totalSegments: correctedData.segments.length,
    totalTiles: tiles.size,
    licensing: reportData.licenses,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Write Coverage Report JSON
  fs.writeFileSync(path.join(outDir, 'coverage-report.json'), JSON.stringify(reportData, null, 2));

  // Write Latest Pointer
  const latestPointer = {
    version,
    releasedAt: new Date().toISOString(),
    manifestUrl: `/datasets/v${version}/manifest.json`,
  };
  const rootDatasetDir = path.resolve(process.cwd(), 'dist/railway-dataset');
  fs.writeFileSync(path.join(rootDatasetDir, 'latest.json'), JSON.stringify(latestPointer, null, 2));

  // Write H3 Tiles
  for (const [cellId, tileData] of tiles.entries()) {
    fs.writeFileSync(path.join(h3Dir, `${cellId}.json`), JSON.stringify(tileData, null, 2));
  }

  // Write Markdown Report to docs/implementations/kanto-coverage-report.md
  const docsDir = path.resolve(process.cwd(), 'docs/implementations');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'kanto-coverage-report.md'), markdownReport);

  console.log(`[ETL] Kanto Dataset Build Completed Successfully! Output: ${outDir}`);
}

// Execute if run directly
if (require.main === module || process.argv[1]?.includes('build-kanto-dataset')) {
  buildKantoDataset().catch(console.error);
}
