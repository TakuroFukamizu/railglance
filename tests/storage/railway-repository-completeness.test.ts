import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DexieRailwayDatabase } from '../../src/infrastructure/storage/dexie-railway-database';
import { H3Tiler } from '../../src/etl/h3-tiler';

const baseUrl = 'https://data.example.test';
const version = '2.0.0';
const coverageLat = 35.5424;
const coverageLon = 139.4456;

let db: DexieRailwayDatabase;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function latest() {
  return {
    version,
    schemaVersion: '1.1.0',
    releasedAt: '2026-08-04T00:00:00.000Z',
    manifestUrl: `/datasets/v${version}/manifest.json`,
  };
}

function manifest() {
  return {
    version,
    schemaVersion: '1.1.0',
    generatedAt: '2026-08-04T00:00:00.000Z',
    area: 'test',
    totalLines: 2,
    totalRoutes: 0,
    totalStations: 4,
    totalSegments: 0,
    totalTiles: 1,
  };
}

beforeEach(async () => {
  db = new DexieRailwayDatabase({
    databaseName: `RailGlanceCompletenessTest-${crypto.randomUUID()}`,
    remoteBaseUrl: null,
  });
  await db.initialize();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete();
});

describe('DexieRailwayDatabase getStationDataCompleteness', () => {
  it('returns false for a bundled line when no remote manifest is connected', async () => {
    expect(await db.getStationDataCompleteness('odakyu-odawara')).toBe(false);
  });

  describe('after a successful remote tile load', () => {
    beforeEach(async () => {
      const cellId = new H3Tiler(6).latLonToCellId(coverageLat, coverageLon);
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/datasets/latest.json')) return jsonResponse(latest());
        if (url.endsWith(`/datasets/v${version}/manifest.json`)) return jsonResponse(manifest());
        if (url.includes('/h3/6/')) {
          const requestedCell = url.match(/\/([^/]+)\.json$/)?.[1];
          if (requestedCell !== cellId) return jsonResponse({}, 404);
          return jsonResponse({
            cellId,
            resolution: 6,
            lines: [
              { id: 'odakyu-odawara', operatorId: 'odakyu', name: '小田急小田原線' },
              { id: 'mlit-line-test', operatorId: 'mlit', name: 'MLIT Test Line' },
            ],
            routes: [],
            stations: [
              {
                id: 'st-machida',
                lineId: 'odakyu-odawara',
                name: '町田',
                sequence: 7,
                latitude: 35.5424,
                longitude: 139.4456,
              },
              {
                id: 'st-shinyurigaoka',
                lineId: 'odakyu-odawara',
                name: '新百合ヶ丘',
                sequence: 8,
                latitude: 35.6038,
                longitude: 139.5076,
              },
              {
                id: 'mlit-station-a',
                lineId: 'mlit-line-test',
                name: 'MLIT A',
                sequence: 1,
                latitude: 35.5424,
                longitude: 139.4456,
              },
              {
                id: 'mlit-station-b',
                lineId: 'mlit-line-test',
                name: 'MLIT B',
                sequence: 2,
                latitude: 35.55,
                longitude: 139.45,
              },
            ],
            segments: [],
          });
        }
        return jsonResponse({}, 404);
      }));

      await db.connectRemoteManifest(baseUrl);
      await db.ensureCoverageAround(coverageLat, coverageLon);
    });

    it('returns false for a bundled line id even when remote rows exist under the same id', async () => {
      const remoteBundledLineCount = await db.remoteStations
        .where('datasetVersion')
        .equals(version)
        .filter((station) => station.lineId === 'odakyu-odawara')
        .count();
      expect(remoteBundledLineCount).toBeGreaterThan(0);
      expect(await db.getStationDataCompleteness('odakyu-odawara')).toBe(false);
    });

    it('returns true for a remote-only line id that is not in the bundled sample table', async () => {
      const bundledMlitCount = await db.stations.where('lineId').equals('mlit-line-test').count();
      expect(bundledMlitCount).toBe(0);

      const remoteMlitCount = await db.remoteStations
        .where('datasetVersion')
        .equals(version)
        .filter((station) => station.lineId === 'mlit-line-test')
        .count();
      expect(remoteMlitCount).toBeGreaterThan(0);
      expect(await db.getStationDataCompleteness('mlit-line-test')).toBe(true);
    });
  });
});
