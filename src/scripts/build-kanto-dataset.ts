import * as fs from 'fs';
import * as path from 'path';
import { ExistingJsonRailwayAdapter } from '../etl/adapters/existing-json-adapter';
import { MlitRailwayAdapter } from '../etl/adapters/mlit-adapter';
import { ManualCorrectionAdapter } from '../etl/adapters/manual-correction-adapter';
import { TopologyBuilder } from '../etl/topology-builder';
import { H3Tiler } from '../etl/h3-tiler';
import { CoverageReporter } from '../etl/coverage-reporter';
import { RAILWAY_DATASET_SCHEMA_VERSION } from '../infrastructure/storage/railway-dataset-schema';
import { MLIT_SOURCE_ID } from '../domain/models/provenance';

export type DatasetBuildOptions = {
  outputRoot?: string;
  reportPath?: string | null;
  mlitSourceDirectory?: string;
  requireMlitSource?: boolean;
};

/** Source id reported by MlitRailwayAdapter; recorded in the manifest so deploys can require it. */
export { MLIT_SOURCE_ID };

/** Version used for sample-only local builds so they can never be mistaken for a release. */
export const SAMPLE_DATASET_VERSION = '0.0.0-sample';

const EXPLICIT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function buildKantoDataset(
  version: string,
  schemaVersion = RAILWAY_DATASET_SCHEMA_VERSION,
  options: DatasetBuildOptions = {}
): Promise<void> {
  if (!EXPLICIT_SEMVER.test(version)) {
    throw new Error(`Dataset version must be an explicit semantic version, received: ${version || '(empty)'}`);
  }
  if (schemaVersion !== RAILWAY_DATASET_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion ${schemaVersion}; expected ${RAILWAY_DATASET_SCHEMA_VERSION}`);
  }
  console.log(`[ETL] Starting Kanto Region Railway Dataset Build (v${version}, schemaVersion ${schemaVersion})...`);

  // 1. Load data from adapters
  const existingAdapter = new ExistingJsonRailwayAdapter();
  const mlitAdapter = new MlitRailwayAdapter({
    sourceDirectory: options.mlitSourceDirectory,
    strict: options.requireMlitSource ?? false,
  });
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

  const mergedDataset = {
    lines: Array.from(lineMap.values()),
    stations: Array.from(stationMap.values()),
    segments: Array.from(segmentMap.values()),
  };

  // 2. Corrections can alter connectivity, so apply them before route generation.
  const correctedRawData = manualAdapter.applyCorrections(mergedDataset);
  const stationIds = new Set(correctedRawData.stations.map((station) => station.id));
  const supportedLineIds = new Set(
    correctedRawData.lines
      .filter((line) => {
        const stationCount = correctedRawData.stations.filter((station) => station.lineId === line.id).length;
        const segmentCount = correctedRawData.segments.filter(
          (segment) => segment.lineId === line.id &&
            stationIds.has(segment.fromStationId) && stationIds.has(segment.toStationId)
        ).length;
        return stationCount >= 2 && segmentCount >= 1;
      })
      .map((line) => line.id)
  );
  const publishableData = {
    lines: correctedRawData.lines.filter((line) => supportedLineIds.has(line.id)),
    stations: correctedRawData.stations.filter((station) => supportedLineIds.has(station.lineId)),
    segments: correctedRawData.segments.filter((segment) => supportedLineIds.has(segment.lineId)),
  };
  if (publishableData.lines.length === 0) {
    throw new Error('Dataset quality gate failed: no line has at least two stations and one segment');
  }

  // 3. Build topology after corrections with offsets, graph connections, and routes.
  const topologyBuilder = new TopologyBuilder();
  const topologizedData = topologyBuilder.buildTopology(
    publishableData.lines,
    publishableData.stations,
    publishableData.segments
  );

  // 4. Generate H3 Spatial Tiles
  const h3Tiler = new H3Tiler(6);
  const tiles = h3Tiler.generateTiles(
    topologizedData.lines,
    topologizedData.routes,
    topologizedData.stations,
    topologizedData.segments
  );

  // 5. Generate Coverage Report
  const coverageReporter = new CoverageReporter();
  const reportData = coverageReporter.generateReport(
    version,
    topologizedData.lines,
    topologizedData.stations,
    topologizedData.segments,
    tiles
  );
  const markdownReport = coverageReporter.renderMarkdownReport(reportData);

  // 6. Write Output Files to dist/railway-dataset/v{version}/ and docs/
  const outputRoot = options.outputRoot ?? path.resolve(process.cwd(), 'dist/railway-dataset');
  const outDir = path.join(outputRoot, `v${version}`);
  const h3Dir = path.join(outDir, 'h3', '6');
  fs.mkdirSync(h3Dir, { recursive: true });

  // Write Manifest
  const sourceIds = reportData.licenses.map((license) => license.sourceId);
  const manifest = {
    version,
    schemaVersion,
    generatedAt: new Date().toISOString(),
    area: 'Kanto buffer; only lines passing station, polyline, and topology quality gates',
    sources: sourceIds,
    // Deploy tooling refuses to publish a dataset that was not built from the official MLIT source.
    mlitSourced: sourceIds.includes(MLIT_SOURCE_ID),
    totalLines: topologizedData.lines.length,
    totalRoutes: topologizedData.routes.length,
    totalStations: topologizedData.stations.length,
    totalSegments: topologizedData.segments.length,
    totalTiles: tiles.size,
    licensing: reportData.licenses,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Write Coverage Report JSON
  fs.writeFileSync(path.join(outDir, 'coverage-report.json'), JSON.stringify(reportData, null, 2));

  // Write Latest Pointer
  const latestPointer = {
    version,
    schemaVersion,
    releasedAt: new Date().toISOString(),
    manifestUrl: `/datasets/v${version}/manifest.json`,
  };
  fs.writeFileSync(path.join(outputRoot, 'latest.json'), JSON.stringify(latestPointer, null, 2));

  // Write H3 Tiles
  for (const [cellId, tileData] of tiles.entries()) {
    fs.writeFileSync(path.join(h3Dir, `${cellId}.json`), JSON.stringify(tileData, null, 2));
  }

  // Write Markdown Report to docs/implementations/kanto-coverage-report.md
  const reportPath = options.reportPath === undefined
    ? path.resolve(process.cwd(), 'docs/implementations/kanto-coverage-report.md')
    : options.reportPath;
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, markdownReport);
  }

  console.log(`[ETL] Kanto Dataset Build (Schema v${schemaVersion}) Completed Successfully! Output: ${outDir}`);
}

export type DatasetBuildCliArguments = {
  version: string;
  allowSample: boolean;
};

/**
 * Resolves the CLI contract. Publishable builds are fail closed: an explicit SemVer and the
 * official MLIT source are both mandatory unless the caller opted into a sample-only build.
 */
export function resolveDatasetBuildCliArguments(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): DatasetBuildCliArguments {
  const versionFlagIndex = argv.indexOf('--version');
  if (versionFlagIndex >= 0) {
    // A malformed `--version` is an invocation error in every mode; never let the next flag or an
    // empty token be swallowed as if it were the version.
    const versionFlagValue = argv[versionFlagIndex + 1];
    if (versionFlagValue === undefined || versionFlagValue.startsWith('-') || versionFlagValue.trim() === '') {
      throw new Error(
        `--version requires a value (e.g. --version 1.4.0), received: ${
          versionFlagValue === undefined ? '<missing>' : JSON.stringify(versionFlagValue)
        }`
      );
    }
  }
  const explicitVersion = (versionFlagIndex >= 0 ? argv[versionFlagIndex + 1] : env.DATASET_VERSION)?.trim();
  const allowSample = argv.includes('--allow-sample') || env.ALLOW_SAMPLE_DATASET === 'true';

  if (!allowSample && !env.MLIT_N02_DIR) {
    throw new Error(
      'MLIT_N02_DIR is required to build a publishable dataset. Set it to the extracted N02-23 GeoJSON directory, ' +
        'or pass --allow-sample (pnpm build:data:sample) to build a local sample-only dataset that must not be deployed.'
    );
  }
  if (allowSample) {
    // A sample build never carries a release version, even when DATASET_VERSION is exported in the shell.
    if (explicitVersion && explicitVersion !== SAMPLE_DATASET_VERSION) {
      console.warn(
        `[ETL] Ignoring requested version ${explicitVersion} for a sample-only build; using ${SAMPLE_DATASET_VERSION}.`
      );
    }
    return { version: SAMPLE_DATASET_VERSION, allowSample };
  }
  if (!explicitVersion) {
    throw new Error(
      'DATASET_VERSION (or --version <x.y.z>) is required to build a publishable dataset; there is no default version.'
    );
  }
  if (!EXPLICIT_SEMVER.test(explicitVersion)) {
    throw new Error(`Dataset version must be an explicit semantic version, received: ${explicitVersion}`);
  }
  return { version: explicitVersion, allowSample };
}

export async function runDatasetBuildCli(argv: string[] = process.argv): Promise<void> {
  const { version, allowSample } = resolveDatasetBuildCliArguments(argv);
  if (allowSample) {
    console.warn(
      `[ETL] Sample-only build requested (--allow-sample). Output v${version} is for local development and must never be deployed to R2.`
    );
    // Keep the committed coverage report describing the published dataset, not a sample build.
    await buildKantoDataset(version, undefined, {
      requireMlitSource: false,
      reportPath: path.resolve(process.cwd(), 'dist/railway-dataset/kanto-coverage-report.sample.md'),
    });
    return;
  }
  await buildKantoDataset(version, undefined, { requireMlitSource: true });
}

// Execute if run directly
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('build-kanto-dataset')) {
  runDatasetBuildCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
