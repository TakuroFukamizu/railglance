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

import { DATASET_QUALITY_GATE, deployToR2 } from '../../src/scripts/deploy-r2';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'railglance-r2-test-'));
const datasetRoot = path.join(testRoot, 'railway-dataset');

type ManifestOverrides = Record<string, unknown>;

/** Writes a dataset tree that satisfies every deploy gate unless an override weakens it. */
function writeDataset(
  baseDir: string,
  options: { version?: string; latest?: Record<string, unknown>; manifest?: ManifestOverrides } = {}
): string {
  const version = options.version ?? '2.0.0';
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(baseDir, `v${version}`, 'h3', '6'), { recursive: true });
  fs.writeFileSync(
    path.join(baseDir, 'latest.json'),
    JSON.stringify(options.latest ?? { version, schemaVersion: '1.1.0' })
  );
  const manifest = {
    version,
    schemaVersion: '1.1.0',
    sources: ['railglance-existing-sample', 'mlit-n02-23'],
    mlitSourced: true,
    totalLines: 421,
    totalStations: 4_612,
    totalSegments: 4_318,
    totalTiles: 1_902,
    ...options.manifest,
  };
  fs.writeFileSync(path.join(baseDir, `v${version}`, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(baseDir, `v${version}`, 'h3', '6', 'cell.json'), '{}');
  return baseDir;
}

/** Asserts no object/CORS write ever reached R2, independent of where validation short-circuited. */
function expectNoUploads(): void {
  const commandNames = aws.send.mock.calls.map(([command]) => command.constructor.name);
  expect(commandNames).not.toContain('PutObjectCommand');
  expect(commandNames).not.toContain('PutBucketCorsCommand');
}

beforeAll(() => {
  writeDataset(datasetRoot);
});

function clearDeployEnv(): void {
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_CORS_ALLOWED_ORIGINS;
  delete process.env.DATASET_VERSION;
}

afterEach(() => {
  vi.clearAllMocks();
  clearDeployEnv();
});

beforeEach(() => {
  clearDeployEnv();
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

/** Every deploy in these tests is explicit about its inputs; nothing is inherited from a local .env. */
function deploy(overrides: Parameters<typeof deployToR2>[0] = {}) {
  return deployToR2({ datasetBaseDir: datasetRoot, datasetVersion: '2.0.0', skipEnvLoad: true, ...overrides });
}

describe('deployToR2', () => {
  it('fails without credentials unless dry-run is explicit', async () => {
    await expect(deploy()).rejects.toThrow(/credentials are required/);
    await expect(deploy({ dryRun: true })).resolves.toBeUndefined();
  });

  it('configures CORS, uploads only the selected immutable version, then switches latest last', async () => {
    setCredentials();
    aws.send.mockRejectedValueOnce(Object.assign(new Error('Not Found'), {
      name: 'NotFound', $metadata: { httpStatusCode: 404 },
    })).mockResolvedValue({});

    await deploy();

    const commandNames = aws.send.mock.calls.map(([command]) => command.constructor.name);
    expect(commandNames.slice(0, 2)).toEqual(['HeadObjectCommand', 'PutBucketCorsCommand']);
    expect(commandNames.at(-1)).toBe('PutObjectCommand');
    const lastCommand = aws.send.mock.calls.at(-1)?.[0];
    expect(lastCommand.input).toMatchObject({
      Key: 'datasets/latest.json',
      CacheControl: 'public, max-age=300, must-revalidate',
    });
  });

  it('reads the requested version from DATASET_VERSION when no explicit option is given', async () => {
    setCredentials();
    process.env.DATASET_VERSION = '2.0.0';
    aws.send.mockRejectedValueOnce(Object.assign(new Error('Not Found'), {
      name: 'NotFound', $metadata: { httpStatusCode: 404 },
    })).mockResolvedValue({});

    await deployToR2({ datasetBaseDir: datasetRoot, skipEnvLoad: true });

    const keys = aws.send.mock.calls
      .map(([command]) => command.input.Key)
      .filter((key: unknown): key is string => typeof key === 'string');
    expect(keys).toContain('datasets/v2.0.0/manifest.json');
  });

  it('refuses to overwrite a version whose manifest already exists', async () => {
    setCredentials();
    aws.send.mockResolvedValue({});
    await expect(deploy()).rejects.toThrow(/immutable/);
    expect(aws.send).toHaveBeenCalledTimes(1);
    expectNoUploads();
  });

  it('fails closed when manifest existence cannot be checked', async () => {
    setCredentials();
    aws.send.mockRejectedValueOnce(Object.assign(new Error('Access denied'), {
      name: 'AccessDenied', $metadata: { httpStatusCode: 403 },
    }));

    await expect(deploy()).rejects.toThrow(/Access denied/);
    expect(aws.send).toHaveBeenCalledTimes(1);
    expectNoUploads();
  });

  describe('CORS origin allowlist', () => {
    it('accepts a sole wildcard because the public dataset bucket cannot enumerate Even App loopback ports', async () => {
      setCredentials();
      process.env.R2_CORS_ALLOWED_ORIGINS = '*';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      aws.send.mockRejectedValueOnce(Object.assign(new Error('Not Found'), {
        name: 'NotFound', $metadata: { httpStatusCode: 404 },
      })).mockResolvedValue({});

      try {
        await deploy();
        const corsCommand = aws.send.mock.calls.find(([command]) => command.constructor.name === 'PutBucketCorsCommand')?.[0];
        expect(corsCommand?.input).toMatchObject({
          CORSConfiguration: { CORSRules: [{ AllowedOrigins: ['*'] }] },
        });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pub-\*\.r2\.dev/));
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ephemeral-port|ephemeral port/i));
      } finally {
        warn.mockRestore();
      }
    });

    it('rejects a mixed CORS list that includes a wildcard', async () => {
      setCredentials();
      process.env.R2_CORS_ALLOWED_ORIGINS = '*,https://foo.example';
      await expect(deploy()).rejects.toThrow(/sole entry/);
      expectNoUploads();
    });

    it('still rejects an empty CORS origin list', async () => {
      setCredentials();
      delete process.env.R2_CORS_ALLOWED_ORIGINS;
      await expect(deploy()).rejects.toThrow(/R2_CORS_ALLOWED_ORIGINS is required/);
      expectNoUploads();
    });
  });

  describe('fail-closed dataset gates (no object may be uploaded)', () => {
    beforeEach(() => {
      setCredentials();
      aws.send.mockResolvedValue({});
    });

    it('uploads nothing when DATASET_VERSION is not set', async () => {
      await expect(deployToR2({ datasetBaseDir: datasetRoot, skipEnvLoad: true }))
        .rejects.toThrow(/DATASET_VERSION is required/);
      expect(aws.send).not.toHaveBeenCalled();
      expectNoUploads();
    });

    it('uploads nothing when DATASET_VERSION is not an explicit SemVer', async () => {
      await expect(deploy({ datasetVersion: 'latest' }))
        .rejects.toThrow(/must be an explicit semantic version/);
      expect(aws.send).not.toHaveBeenCalled();
      expectNoUploads();
    });

    it('uploads nothing when latest.json carries no explicit version', async () => {
      const baseDir = writeDataset(path.join(testRoot, 'no-version'), { latest: { schemaVersion: '1.1.0' } });

      await expect(deploy({ datasetBaseDir: baseDir }))
        .rejects.toThrow(/latest.json does not contain an explicit semantic version/);
      expect(aws.send).not.toHaveBeenCalled();
      expectNoUploads();
    });

    it('uploads nothing when the built version differs from the requested version', async () => {
      await expect(deploy({ datasetVersion: '2.1.0' })).rejects.toThrow(/does not match requested DATASET_VERSION/);
      expect(aws.send).not.toHaveBeenCalled();
      expectNoUploads();
    });

    it('uploads nothing when the dataset was built without the MLIT source', async () => {
      const baseDir = writeDataset(path.join(testRoot, 'sample-only'), {
        manifest: { sources: ['railglance-existing-sample'], mlitSourced: false },
      });

      await expect(deploy({ datasetBaseDir: baseDir })).rejects.toThrow(/was not built from the official MLIT source/);
      expect(aws.send).not.toHaveBeenCalled();
      expectNoUploads();
    });

    it('uploads nothing when a sample-only build only claims the MLIT flag', async () => {
      const baseDir = writeDataset(path.join(testRoot, 'forged-flag'), {
        manifest: { sources: ['railglance-existing-sample'], mlitSourced: true },
      });

      await expect(deploy({ datasetBaseDir: baseDir })).rejects.toThrow(/was not built from the official MLIT source/);
      expect(aws.send).not.toHaveBeenCalled();
      expectNoUploads();
    });

    it('uploads nothing when the dataset falls under the minimum line and station counts', async () => {
      const baseDir = writeDataset(path.join(testRoot, 'too-small'), {
        manifest: {
          totalLines: DATASET_QUALITY_GATE.minLines - 1,
          totalStations: DATASET_QUALITY_GATE.minStations - 1,
        },
      });

      await expect(deploy({ datasetBaseDir: baseDir })).rejects.toThrow(/failed the deploy quality gate/);
      expect(aws.send).not.toHaveBeenCalled();
      expectNoUploads();
    });

    it('uploads nothing when the manifest omits its counts', async () => {
      const baseDir = writeDataset(path.join(testRoot, 'no-counts'), {
        manifest: { totalStations: undefined },
      });

      await expect(deploy({ datasetBaseDir: baseDir })).rejects.toThrow(/missing a numeric "totalStations"/);
      expect(aws.send).not.toHaveBeenCalled();
      expectNoUploads();
    });
  });
});
