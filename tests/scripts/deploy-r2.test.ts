import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const aws = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: class { send = aws.send; },
    HeadObjectCommand: class HeadObjectCommand extends Command {},
    PutBucketCorsCommand: class PutBucketCorsCommand extends Command {},
    PutObjectCommand: class PutObjectCommand extends Command {},
  };
});

import { deployToR2 } from '../../src/scripts/deploy-r2';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'railglance-r2-test-'));
const datasetRoot = path.join(testRoot, 'railway-dataset');

beforeAll(() => {
  fs.mkdirSync(path.join(datasetRoot, 'v2.0.0', 'h3', '6'), { recursive: true });
  fs.writeFileSync(path.join(datasetRoot, 'latest.json'), JSON.stringify({ version: '2.0.0' }));
  fs.writeFileSync(path.join(datasetRoot, 'v2.0.0', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(datasetRoot, 'v2.0.0', 'h3', '6', 'cell.json'), '{}');
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_CORS_ALLOWED_ORIGINS;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
});

beforeEach(() => {
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_CORS_ALLOWED_ORIGINS;
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function setCredentials(): void {
  process.env.R2_ACCOUNT_ID = 'account';
  process.env.R2_ACCESS_KEY_ID = 'key';
  process.env.R2_SECRET_ACCESS_KEY = 'secret';
  process.env.R2_CORS_ALLOWED_ORIGINS = 'https://app.example';
}

describe('deployToR2', () => {
  it('fails without credentials unless dry-run is explicit', async () => {
    await expect(deployToR2({ datasetBaseDir: datasetRoot })).rejects.toThrow(/credentials are required/);
    await expect(deployToR2({ dryRun: true, datasetBaseDir: datasetRoot })).resolves.toBeUndefined();
  });

  it('configures CORS, uploads only the selected immutable version, then switches latest last', async () => {
    setCredentials();
    aws.send.mockRejectedValueOnce(Object.assign(new Error('Not Found'), {
      name: 'NotFound', $metadata: { httpStatusCode: 404 },
    })).mockResolvedValue({});

    await deployToR2({ datasetBaseDir: datasetRoot });

    const commandNames = aws.send.mock.calls.map(([command]) => command.constructor.name);
    expect(commandNames.slice(0, 2)).toEqual(['HeadObjectCommand', 'PutBucketCorsCommand']);
    expect(commandNames.at(-1)).toBe('PutObjectCommand');
    const lastCommand = aws.send.mock.calls.at(-1)?.[0];
    expect(lastCommand.input).toMatchObject({
      Key: 'datasets/latest.json',
      CacheControl: 'public, max-age=300, must-revalidate',
    });
  });

  it('refuses to overwrite a version whose manifest already exists', async () => {
    setCredentials();
    aws.send.mockResolvedValue({});
    await expect(deployToR2({ datasetBaseDir: datasetRoot })).rejects.toThrow(/immutable/);
    expect(aws.send).toHaveBeenCalledTimes(1);
  });

  it('fails closed when manifest existence cannot be checked', async () => {
    setCredentials();
    aws.send.mockRejectedValueOnce(Object.assign(new Error('Access denied'), {
      name: 'AccessDenied', $metadata: { httpStatusCode: 403 },
    }));

    await expect(deployToR2({ datasetBaseDir: datasetRoot })).rejects.toThrow(/Access denied/);
    expect(aws.send).toHaveBeenCalledTimes(1);
  });
});
