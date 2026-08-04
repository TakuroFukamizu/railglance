import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MlitRailwayAdapter } from '../../src/etl/adapters/mlit-adapter';

const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'railglance-mlit-test-'));

function writeGeoJson(filename: string, features: unknown[]): void {
  fs.writeFileSync(path.join(sourceDirectory, filename), JSON.stringify({ type: 'FeatureCollection', features }));
}

afterAll(() => {
  fs.rmSync(sourceDirectory, { recursive: true, force: true });
});

describe('MlitRailwayAdapter', () => {
  it('converts real N02 GeoJSON attributes and keeps provenance', async () => {
    const baseProperties = {
      N02_001: '12', N02_002: '5', N02_003: '試験線', N02_004: '試験鉄道',
    };
    writeGeoJson('N02-23_Station.geojson', [
      {
        type: 'Feature',
        properties: { ...baseProperties, N02_005: '始点', N02_005c: '001' },
        geometry: { type: 'LineString', coordinates: [[139, 35], [139, 35]] },
      },
      {
        type: 'Feature',
        properties: { ...baseProperties, N02_005: '終点', N02_005c: '002' },
        geometry: { type: 'LineString', coordinates: [[139, 35.01], [139, 35.01]] },
      },
    ]);
    writeGeoJson('N02-23_RailroadSection.geojson', [{
      type: 'Feature',
      properties: baseProperties,
      geometry: { type: 'LineString', coordinates: [[139, 35], [139, 35.005], [139, 35.01]] },
    }]);

    const result = await new MlitRailwayAdapter({ sourceDirectory, strict: true }).load();
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ name: '試験線', operatorName: '試験鉄道' });
    expect(result.stations.map((station) => station.sequence)).toEqual([1, 2]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].coordinates[0]).toEqual([35, 139]);
    expect(result.segments[0].provenance?.[0]).toMatchObject({
      sourceId: 'mlit-n02-23',
      licenseId: 'CC-BY-4.0',
    });
  });

  it('requires an explicit source for a publishable build', async () => {
    await expect(new MlitRailwayAdapter({ sourceDirectory: '', strict: true }).load()).rejects.toThrow(/MLIT_N02_DIR/);
  });
});
