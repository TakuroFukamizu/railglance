import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DexieRailwayDatabase } from '../../src/infrastructure/storage/dexie-railway-database';
import { H3Tiler } from '../../src/etl/h3-tiler';

const baseUrl = 'https://data.example.test';
let db: DexieRailwayDatabase;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function manifest(version: string) {
  return {
    version,
    schemaVersion: '1.1.0',
    generatedAt: '2026-08-04T00:00:00.000Z',
    area: 'test',
    totalLines: 1,
    totalRoutes: 0,
    totalStations: 0,
    totalSegments: 0,
    totalTiles: 1,
  };
}

function latest(version: string, schemaVersion = '1.1.0') {
  return {
    version,
    schemaVersion,
    releasedAt: '2026-08-04T00:00:00.000Z',
    manifestUrl: `/datasets/v${version}/manifest.json`,
  };
}

beforeEach(async () => {
  db = new DexieRailwayDatabase({
    databaseName: `RailGlanceTest-${crypto.randomUUID()}`,
    remoteBaseUrl: null,
  });
  await db.initialize();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete();
});

describe('railway dataset remote sync', () => {
  it('rejects an unsupported or omitted schema and keeps bundled data active', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      ...latest('2.0.0'),
      schemaVersion: undefined,
    })));

    await expect(db.connectRemoteManifest(baseUrl)).rejects.toThrow(/schemaVersion/);
    expect(db.getDataState()).toBe('bundled');
    expect(await db.getLine('odakyu-odawara')).toBeDefined();
  });

  it('falls back explicitly to bundled data when a browser CORS request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(db.connectRemoteManifest(baseUrl)).rejects.toThrow('Failed to fetch');
    expect(db.getSyncStatus()).toMatchObject({ status: 'bundled', baseUrl });
    expect(await db.getLine('odakyu-odawara')).toBeDefined();
  });

  it('deduplicates tile requests and atomically excludes the previous remote version', async () => {
    const cellId = new H3Tiler(6).latLonToCellId(35.6812, 139.7671);
    let version = '2.0.0';
    const tileFetchCount = new Map<string, number>();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/datasets/latest.json')) return jsonResponse(latest(version));
      if (url.endsWith(`/datasets/v${version}/manifest.json`)) return jsonResponse(manifest(version));
      if (url.includes('/h3/6/')) {
        tileFetchCount.set(url, (tileFetchCount.get(url) ?? 0) + 1);
        const requestedCell = url.match(/\/([^/]+)\.json$/)?.[1];
        if (requestedCell !== cellId) return jsonResponse({}, 404);
        return jsonResponse({
          cellId,
          resolution: 6,
          lines: [{ id: `remote-${version}`, operatorId: 'remote', name: `Remote ${version}` }],
          routes: [],
          stations: [],
          segments: [],
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await db.connectRemoteManifest(baseUrl);
    await Promise.all([
      db.ensureCoverageAround(35.6812, 139.7671),
      db.ensureCoverageAround(35.6812, 139.7671),
    ]);
    expect(await db.getLine('remote-2.0.0')).toBeDefined();
    expect([...tileFetchCount.values()].every((count) => count === 1)).toBe(true);

    version = '2.1.0';
    await db.connectRemoteManifest(baseUrl);
    expect(await db.getLine('remote-2.0.0')).toBeUndefined();
    expect(await db.remoteLines.where('datasetVersion').equals('2.0.0').count()).toBe(0);
    expect(await db.getLine('odakyu-odawara')).toBeDefined();
  });
});
