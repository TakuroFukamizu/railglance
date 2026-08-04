import * as fs from 'fs';
import * as path from 'path';
import {
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type R2DeployOptions = { dryRun?: boolean; datasetBaseDir?: string };

export async function deployToR2(options: R2DeployOptions = {}): Promise<void> {
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
      'R2 credentials are required. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY, or pass --dry-run.'
    );
  }
  if (allowedOrigins.length === 0) {
    throw new Error('R2_CORS_ALLOWED_ORIGINS is required (comma-separated application origins).');
  }
  if (allowedOrigins.includes('*')) {
    throw new Error('R2_CORS_ALLOWED_ORIGINS must contain exact origins; wildcard is not allowed.');
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

  const datasetBaseDir = options.datasetBaseDir ?? path.resolve(process.cwd(), 'dist/railway-dataset');

  if (!fs.existsSync(datasetBaseDir)) {
    throw new Error(`Dataset output directory not found at ${datasetBaseDir}. Run "pnpm build:data" first.`);
  }

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
  if (!fs.existsSync(latestFilePath)) throw new Error('latest.json was not generated');
  const latestPointer = JSON.parse(fs.readFileSync(latestFilePath, 'utf8')) as { version?: string };
  if (!latestPointer.version) throw new Error('latest.json does not contain a version');

  const versionDirectory = path.join(datasetBaseDir, `v${latestPointer.version}`);
  if (!fs.existsSync(versionDirectory)) {
    throw new Error(`Version directory v${latestPointer.version} was not generated`);
  }
  const versionedFilePaths = getAllFiles(versionDirectory);

  const manifestKey = `datasets/v${latestPointer.version}/manifest.json`;
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: manifestKey }));
    throw new Error(`Dataset version ${latestPointer.version} already exists in R2 and is immutable`);
  } catch (error: any) {
    const statusCode = error?.$metadata?.httpStatusCode;
    if (statusCode !== 404 && error?.name !== 'NotFound' && !String(error?.message).includes('immutable')) {
      throw error;
    }
    if (String(error?.message).includes('immutable')) throw error;
  }

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
