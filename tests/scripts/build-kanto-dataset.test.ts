import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SAMPLE_DATASET_VERSION,
  buildKantoDataset,
  resolveDatasetBuildCliArguments,
} from '../../src/scripts/build-kanto-dataset';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'railglance-build-cli-'));

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('build-kanto-dataset CLI contract', () => {
  it('refuses a publishable build without the MLIT source directory', () => {
    expect(() => resolveDatasetBuildCliArguments(['node', 'build', '--version', '1.4.0'], {}))
      .toThrow(/MLIT_N02_DIR is required/);
  });

  it('refuses a publishable build without an explicit version', () => {
    expect(() => resolveDatasetBuildCliArguments(['node', 'build'], { MLIT_N02_DIR: '/srv/n02' }))
      .toThrow(/DATASET_VERSION .* is required/);
  });

  it('refuses a publishable build whose version is not an explicit SemVer', () => {
    expect(() => resolveDatasetBuildCliArguments(['node', 'build'], { MLIT_N02_DIR: '/srv/n02', DATASET_VERSION: 'latest' }))
      .toThrow(/must be an explicit semantic version/);
  });

  it('accepts an explicit SemVer with an MLIT source directory', () => {
    expect(resolveDatasetBuildCliArguments(['node', 'build'], { MLIT_N02_DIR: '/srv/n02', DATASET_VERSION: '1.4.0' }))
      .toEqual({ version: '1.4.0', allowSample: false });
  });

  it('allows a sample-only build behind the explicit flag and marks it with a sample version', () => {
    expect(resolveDatasetBuildCliArguments(['node', 'build', '--allow-sample'], {}))
      .toEqual({ version: SAMPLE_DATASET_VERSION, allowSample: true });
    expect(resolveDatasetBuildCliArguments(['node', 'build'], { ALLOW_SAMPLE_DATASET: 'true' }))
      .toEqual({ version: SAMPLE_DATASET_VERSION, allowSample: true });
  });

  it('never labels a sample-only build with a requested release version', () => {
    expect(resolveDatasetBuildCliArguments(['node', 'build', '--allow-sample'], { DATASET_VERSION: '1.4.0' }))
      .toEqual({ version: SAMPLE_DATASET_VERSION, allowSample: true });
    expect(resolveDatasetBuildCliArguments(['node', 'build', '--allow-sample', '--version', '1.4.0'], {}))
      .toEqual({ version: SAMPLE_DATASET_VERSION, allowSample: true });
  });
});

describe('dataset manifest provenance', () => {
  const ambientMlitDir = process.env.MLIT_N02_DIR;

  beforeAll(() => {
    delete process.env.MLIT_N02_DIR;
  });

  afterAll(() => {
    if (ambientMlitDir !== undefined) process.env.MLIT_N02_DIR = ambientMlitDir;
  });

  it('marks a sample-only build as not MLIT sourced', async () => {
    const outputRoot = path.join(testRoot, 'railway-dataset');
    await buildKantoDataset(SAMPLE_DATASET_VERSION, undefined, { outputRoot, reportPath: null });

    const manifest = JSON.parse(
      fs.readFileSync(path.join(outputRoot, `v${SAMPLE_DATASET_VERSION}`, 'manifest.json'), 'utf-8')
    );
    expect(manifest.mlitSourced).toBe(false);
    expect(manifest.sources).not.toContain('mlit-n02-23');
    expect(manifest.sources).toContain('railglance-existing-sample');
  });
});
