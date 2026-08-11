import { afterAll, describe, it, expect } from 'vitest';
import { buildKantoDataset } from '../../src/scripts/build-kanto-dataset';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'railglance-etl-'));

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('ETL Pipeline & Kanto Railway Dataset Build', () => {
  it('builds full Kanto dataset and generates manifest, coverage report, and H3 tiles', async () => {
    const outputRoot = path.join(testRoot, 'railway-dataset');
    const docReportPath = path.join(testRoot, 'kanto-coverage-report.md');
    await buildKantoDataset('1.0.0', undefined, { outputRoot, reportPath: docReportPath });

    const outDir = path.join(outputRoot, 'v1.0.0');
    const manifestPath = path.join(outDir, 'manifest.json');
    const reportPath = path.join(outDir, 'coverage-report.json');

    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(docReportPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.schemaVersion).toBe('1.1.0');
    expect(manifest.totalLines).toBeGreaterThan(0);
    expect(manifest.totalStations).toBeGreaterThan(0);
    expect(manifest.totalSegments).toBeGreaterThan(0);

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    expect(report.targetPrefectures.length).toBe(7); // 1都6県
    expect(report.licenses.length).toBeGreaterThan(0);

    const tileNames = fs.readdirSync(path.join(outDir, 'h3', '6'));
    expect(tileNames.length).toBeGreaterThan(0);
    expect(tileNames.every((name) => /^86[0-9a-f]{13}\.json$/.test(name))).toBe(true);
  });
});
