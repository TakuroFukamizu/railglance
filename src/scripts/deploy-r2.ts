import * as fs from 'fs';
import * as path from 'path';
import { MLIT_SOURCE_ID } from '../domain/models/provenance';
import {
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

function loadEnvFile(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

const EXPLICIT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;


/**
 * Minimum publishable dataset size.
 *
 * Derived from the committed baseline dataset (src/data/sample: 7 lines / 56 stations / 49 segments),
 * which `buildKantoDataset` reproduces exactly as 7 lines / 56 stations / 49 segments / 254 H3 tiles.
 * A production (MLIT-sourced) build merges that baseline with the official N02-23 data, so it can never
 * be smaller. A build that lands under these counts is truncated or broken and must not be published.
 */
export const DATASET_QUALITY_GATE = {
  minLines: 7,
  minStations: 56,
  minSegments: 49,
  minTiles: 254,
} as const;

type DatasetManifest = {
  version?: unknown;
  mlitSourced?: unknown;
  sources?: unknown;
  totalLines?: unknown;
  totalStations?: unknown;
  totalSegments?: unknown;
  totalTiles?: unknown;
};

function readCount(manifest: DatasetManifest, field: keyof DatasetManifest): number {
  const value = manifest[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Dataset manifest is missing a numeric "${String(field)}" value; refusing to deploy.`);
  }
  return value;
}

/**
 * Fails closed before any network call: the release must be an explicitly requested SemVer, built from
 * the official MLIT source, and large enough to be a real Kanto dataset rather than the bundled sample.
 */
function assertPublishableDataset(datasetBaseDir: string, requestedVersion: string | undefined): string {
  if (!fs.existsSync(datasetBaseDir)) {
    throw new Error(`Dataset output directory not found at ${datasetBaseDir}. Run "pnpm build:data" first.`);
  }
  if (!requestedVersion) {
    throw new Error(
      'DATASET_VERSION is required to deploy; set it to the explicit SemVer that was built. R2 deploys never infer a version.'
    );
  }
  if (!EXPLICIT_SEMVER.test(requestedVersion)) {
    throw new Error(`DATASET_VERSION must be an explicit semantic version, received: ${requestedVersion}`);
  }

  const latestFilePath = path.join(datasetBaseDir, 'latest.json');
  if (!fs.existsSync(latestFilePath)) throw new Error('latest.json was not generated');
  const latestPointer = JSON.parse(fs.readFileSync(latestFilePath, 'utf8')) as { version?: unknown };
  const builtVersion = latestPointer.version;
  if (typeof builtVersion !== 'string' || !EXPLICIT_SEMVER.test(builtVersion)) {
    throw new Error('latest.json does not contain an explicit semantic version');
  }
  if (builtVersion !== requestedVersion) {
    throw new Error(
      `Built dataset version ${builtVersion} does not match requested DATASET_VERSION ${requestedVersion}; refusing to deploy a stale build.`
    );
  }

  const versionDirectory = path.join(datasetBaseDir, `v${builtVersion}`);
  if (!fs.existsSync(versionDirectory)) {
    throw new Error(`Version directory v${builtVersion} was not generated`);
  }

  const manifestPath = path.join(versionDirectory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest.json was not generated for v${builtVersion}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DatasetManifest;
  if (manifest.version !== builtVersion) {
    throw new Error(`manifest.json version ${String(manifest.version)} does not match latest.json version ${builtVersion}`);
  }

  const sources = Array.isArray(manifest.sources) ? manifest.sources : [];
  if (manifest.mlitSourced !== true || !sources.includes(MLIT_SOURCE_ID)) {
    throw new Error(
      `Dataset v${builtVersion} was not built from the official MLIT source (${MLIT_SOURCE_ID}). ` +
        'Set MLIT_N02_DIR and rebuild with "pnpm build:data"; sample-only builds must never be deployed.'
    );
  }

  const failures: string[] = [];
  const lines = readCount(manifest, 'totalLines');
  const stations = readCount(manifest, 'totalStations');
  const segments = readCount(manifest, 'totalSegments');
  const tiles = readCount(manifest, 'totalTiles');
  if (lines < DATASET_QUALITY_GATE.minLines) failures.push(`lines ${lines} < ${DATASET_QUALITY_GATE.minLines}`);
  if (stations < DATASET_QUALITY_GATE.minStations) failures.push(`stations ${stations} < ${DATASET_QUALITY_GATE.minStations}`);
  if (segments < DATASET_QUALITY_GATE.minSegments) failures.push(`segments ${segments} < ${DATASET_QUALITY_GATE.minSegments}`);
  if (tiles < DATASET_QUALITY_GATE.minTiles) failures.push(`h3 tiles ${tiles} < ${DATASET_QUALITY_GATE.minTiles}`);
  if (failures.length > 0) {
    throw new Error(`Dataset v${builtVersion} failed the deploy quality gate: ${failures.join(', ')}`);
  }

  console.log(
    `[R2 Deploy] Quality gate passed for v${builtVersion}: ${lines} lines, ${stations} stations, ${segments} segments, ${tiles} tiles (MLIT sourced).`
  );
  return builtVersion;
}

export type R2DeployOptions = {
  dryRun?: boolean;
  datasetBaseDir?: string;
  skipEnvLoad?: boolean;
  datasetVersion?: string;
};

export async function deployToR2(options: R2DeployOptions = {}): Promise<void> {
  if (!options.skipEnvLoad && process.env.NODE_ENV !== 'test') {
    loadEnvFile();
  }

  const datasetBaseDir = options.datasetBaseDir ?? path.resolve(process.cwd(), 'dist/railway-dataset');
  const requestedVersion = options.datasetVersion ?? process.env.DATASET_VERSION?.trim();
  // Validated before the S3 client exists so a rejected dataset can never issue a single upload.
  const datasetVersion = assertPublishableDataset(datasetBaseDir, requestedVersion);

  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || 'railglance-dataset-bucket';
  const allowedOrigins = (process.env.R2_CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!accountId || !accessKeyId || !secretAccessKey) {
    if (options.dryRun) {
      console.log('[R2 Deploy] Dry run: credentials are not required and no network changes will be made.');
      return;
    }
    throw new Error(
      'R2 credentials are required. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY in your .env file or environment, or pass --dry-run.'
    );
  }
  if (allowedOrigins.length === 0) {
    throw new Error('R2_CORS_ALLOWED_ORIGINS is required in .env or environment (comma-separated application origins).');
  }
  // Exact origins cannot cover the Even App WebView: it is served from
  // http://127.0.0.1:<ephemeral port>, and R2 rejects port-wildcard origin strings.
  // A bare '*' is accepted by R2 and is safe here because the dataset bucket is already
  // public (pub-*.r2.dev). Require it as the sole entry so a mixed list cannot look
  // like a tightened allowlist while actually allowing every origin.
  const wildcardOnly = allowedOrigins.length === 1 && allowedOrigins[0] === '*';
  if (allowedOrigins.includes('*') && !wildcardOnly) {
    throw new Error(
      'R2_CORS_ALLOWED_ORIGINS may use "*" only as the sole entry; mixing it with exact origins is a configuration mistake.'
    );
  }
  if (wildcardOnly) {
    console.warn(
      '[R2 Deploy] Using CORS origin "*". Intentional: the dataset bucket is public (pub-*.r2.dev) so CORS is not a security boundary, and the Even App WebView serves from an ephemeral-port loopback origin that cannot be enumerated.'
    );
  }

  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const s3Client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  console.log(`[R2 Deploy] Connecting to Cloudflare R2 Endpoint: ${endpoint}`);
  console.log(`[R2 Deploy] Target Bucket: ${bucketName}`);

  // Helper function to recursively collect files
  const getAllFiles = (dirPath: string, arrayOfFiles: string[] = []): string[] => {
    const files = fs.readdirSync(dirPath);
    files.forEach((file) => {
      const fullPath = path.join(dirPath, file);
      if (fs.statSync(fullPath).isDirectory()) {
        arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
      } else {
        arrayOfFiles.push(fullPath);
      }
    });
    return arrayOfFiles;
  };

  const latestFilePath = path.join(datasetBaseDir, 'latest.json');
  const versionDirectory = path.join(datasetBaseDir, `v${datasetVersion}`);
  const versionedFilePaths = getAllFiles(versionDirectory);

  const manifestKey = `datasets/v${datasetVersion}/manifest.json`;
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: manifestKey }));
    throw new Error(`Dataset version ${datasetVersion} already exists in R2 and is immutable`);
  } catch (error: any) {
    const statusCode = error?.$metadata?.httpStatusCode;
    if (statusCode !== 404 && error?.name !== 'NotFound' && !String(error?.message).includes('immutable')) {
      throw error;
    }
    if (String(error?.message).includes('immutable')) throw error;
  }

  // Soft CORS setup attempt (non-fatal if token doesn't have PutBucketCors permission)
  try {
    await s3Client.send(
      new PutBucketCorsCommand({
        Bucket: bucketName,
        CORSConfiguration: {
          CORSRules: [{
            AllowedOrigins: allowedOrigins,
            AllowedMethods: ['GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 86400,
          }],
        },
      })
    );
    console.log(`[R2 Deploy] CORS configured for: ${allowedOrigins.join(', ')}`);
  } catch (corsError: any) {
    console.warn(`[R2 Deploy Notice] Bucket CORS configuration skipped (non-fatal): ${corsError.message || corsError}`);
  }

  console.log(`[R2 Deploy] Uploading ${versionedFilePaths.length} versioned tile/manifest objects...`);

  // 1. Upload all versioned dataset files with 1-year immutable cache control
  for (const filePath of versionedFilePaths) {
    const relativePath = path.relative(datasetBaseDir, filePath);
    const key = `datasets/${relativePath.replace(/\\/g, '/')}`;
    const fileContent = fs.readFileSync(filePath);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: fileContent,
        ContentType: 'application/json',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
    console.log(`  ✓ Uploaded: ${key} (Cache: 1 Year Immutable)`);
  }

  // 2. Upload latest.json pointer LAST to ensure atomic switch (preventing 404 cache)
  if (latestFilePath) {
    const relativePath = path.relative(datasetBaseDir, latestFilePath);
    const key = `datasets/${relativePath.replace(/\\/g, '/')}`;
    const fileContent = fs.readFileSync(latestFilePath);

    console.log(`[R2 Deploy] Switching pointer: Uploading ${key} (Short TTL: 300s)...`);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: fileContent,
        ContentType: 'application/json',
        CacheControl: 'public, max-age=300, must-revalidate',
      })
    );
    console.log(`  ✓ Successfully switched latest pointer: ${key}`);
  }

  console.log(`[R2 Deploy] All ${versionedFilePaths.length + 1} dataset objects deployed successfully to Cloudflare R2!`);
}

// Execute if run directly
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('deploy-r2')) {
  deployToR2({ dryRun: process.argv.includes('--dry-run') }).catch((err) => {
    console.error('[R2 Deploy Error]:', err);
    process.exit(1);
  });
}
