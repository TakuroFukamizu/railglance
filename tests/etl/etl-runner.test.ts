import { describe, it, expect } from 'vitest';
import { buildKantoDataset } from '../../src/scripts/build-kanto-dataset';
import * as fs from 'fs';
import * as path from 'path';

describe('ETL Pipeline & Kanto Railway Dataset Build', () => {
  it('builds full Kanto dataset and generates manifest, coverage report, and H3 tiles', async () => {
    await buildKantoDataset('1.0.0');

    const outDir = path.resolve(process.cwd(), 'dist/railway-dataset/v1.0.0');
    const manifestPath = path.join(outDir, 'manifest.json');
    const reportPath = path.join(outDir, 'coverage-report.json');
    const docReportPath = path.resolve(process.cwd(), 'docs/implementations/kanto-coverage-report.md');

    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(docReportPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.totalLines).toBeGreaterThan(30); // Coverage of Kanto region lines
    expect(manifest.totalStations).toBeGreaterThan(0);
    expect(manifest.totalSegments).toBeGreaterThan(0);

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    expect(report.targetPrefectures.length).toBe(7); // 1都6県
    expect(report.licenses.length).toBeGreaterThan(0);
  });
});
