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

  it('keeps a branched MLIT line instead of dropping every segment', async () => {
    const branchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'railglance-mlit-branch-test-'));
    const properties = { N02_003: '分岐試験線', N02_004: '試験鉄道' };
    const station = (name: string, code: string, longitude: number, latitude: number) => ({
      type: 'Feature',
      properties: { ...properties, N02_005: name, N02_005c: code },
      geometry: { type: 'LineString', coordinates: [[longitude, latitude], [longitude, latitude]] },
    });
    try {
      fs.writeFileSync(path.join(branchDirectory, 'N02-23_Station.geojson'), JSON.stringify({
        type: 'FeatureCollection',
        features: [
          station('A', '001', 139.0, 35.0),
          station('J', '002', 139.01, 35.0),
          station('B', '003', 139.02, 35.0),
          station('C', '004', 139.01, 35.01),
        ],
      }));
      fs.writeFileSync(path.join(branchDirectory, 'N02-23_RailroadSection.geojson'), JSON.stringify({
        type: 'FeatureCollection',
        features: [
          [[139.0, 35.0], [139.01, 35.0]],
          [[139.01, 35.0], [139.02, 35.0]],
          [[139.01, 35.0], [139.01, 35.01]],
        ].map((coordinates) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates } })),
      }));

      const result = await new MlitRailwayAdapter({ sourceDirectory: branchDirectory, strict: true }).load();
      expect(result.lines).toHaveLength(1);
      expect(result.stations).toHaveLength(4);
      expect(result.segments).toHaveLength(3);
    } finally {
      fs.rmSync(branchDirectory, { recursive: true, force: true });
    }
  });

  it('keeps disconnected components that MLIT assigns to one line', async () => {
    const componentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'railglance-mlit-component-test-'));
    const properties = { N02_003: '成分試験線', N02_004: '試験鉄道' };
    const station = (name: string, code: string, longitude: number) => ({
      type: 'Feature',
      properties: { ...properties, N02_005: name, N02_005c: code },
      geometry: { type: 'LineString', coordinates: [[longitude, 35], [longitude, 35]] },
    });
    try {
      fs.writeFileSync(path.join(componentDirectory, 'N02-23_Station.geojson'), JSON.stringify({
        type: 'FeatureCollection',
        features: [station('A', '001', 139.0), station('B', '002', 139.01), station('C', '003', 139.03), station('D', '004', 139.04)],
      }));
      fs.writeFileSync(path.join(componentDirectory, 'N02-23_RailroadSection.geojson'), JSON.stringify({
        type: 'FeatureCollection',
        features: [
          [[139.0, 35], [139.01, 35]],
          [[139.03, 35], [139.04, 35]],
        ].map((coordinates) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates } })),
      }));

      const result = await new MlitRailwayAdapter({ sourceDirectory: componentDirectory, strict: true }).load();
      expect(result.lines).toHaveLength(1);
      expect(result.stations).toHaveLength(4);
      expect(result.segments).toHaveLength(2);
    } finally {
      fs.rmSync(componentDirectory, { recursive: true, force: true });
    }
  });
});
