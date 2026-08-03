import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export async function deployToR2(): Promise<void> {
  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || 'railglance-dataset-bucket';

  if (!accountId || !accessKeyId || !secretAccessKey) {
    console.log('[R2 Deploy Notice] Cloudflare R2 credentials not found in environment.');
    console.log('Required Environment Variables:');
    console.log('  - R2_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID)');
    console.log('  - R2_ACCESS_KEY_ID');
    console.log('  - R2_SECRET_ACCESS_KEY');
    console.log('  - R2_BUCKET_NAME (optional, defaults to "railglance-dataset-bucket")');
    console.log('\nSkipping actual R2 network upload (dry-run mode).');
    return;
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

  const datasetBaseDir = path.resolve(process.cwd(), 'dist/railway-dataset');

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

  const allFilePaths = getAllFiles(datasetBaseDir);
  const versionedFilePaths = allFilePaths.filter((p) => !p.endsWith('latest.json'));
  const latestFilePath = allFilePaths.find((p) => p.endsWith('latest.json'));

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

  console.log(`[R2 Deploy] All ${allFilePaths.length} dataset objects deployed successfully to Cloudflare R2!`);
}

// Execute if run directly
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('deploy-r2')) {
  deployToR2().catch((err) => {
    console.error('[R2 Deploy Error]:', err);
    process.exit(1);
  });
}
