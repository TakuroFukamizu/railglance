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
    sources: ['mlit-n02-23'],
    mlitSourced: true,
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
  it('rejects a remote dataset that lacks official MLIT provenance', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/datasets/latest.json')) return jsonResponse(latest('2.0.0'));
      if (url.endsWith('/datasets/v2.0.0/manifest.json')) {
        return jsonResponse({
          ...manifest('2.0.0'),
          sources: ['railglance-existing-sample'],
          mlitSourced: false,
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(db.connectRemoteManifest(baseUrl)).rejects.toThrow(/MLIT provenance/);
    expect(db.getDataState()).toBe('bundled');
  });

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

  it('computes the H3 cellId even when no remote is configured', async () => {
    const latitude = 35.6812;
    const longitude = 139.7671;
    const expectedCellId = new H3Tiler(6).latLonToCellId(latitude, longitude);

    const result = await db.ensureCoverageAround(latitude, longitude);

    expect(result.cellId).toBe(expectedCellId);
    expect(db.getSyncStatus().currentCellId).toBe(expectedCellId);
  });

  it('records latest and manifest fetch diagnostics on a successful connect', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/datasets/latest.json')) return jsonResponse(latest('2.0.0'));
      if (url.endsWith('/datasets/v2.0.0/manifest.json')) return jsonResponse(manifest('2.0.0'));
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    await db.connectRemoteManifest(baseUrl);
    const after = Date.now();
    const status = db.getSyncStatus();

    expect(status.latestFetchStatus).toBe('ok');
    expect(status.manifestFetchStatus).toBe('ok');
    expect(status.latestUrl).toBe(`${baseUrl}/datasets/latest.json`);
    expect(status.manifestUrl).toBe(`${baseUrl}/datasets/v2.0.0/manifest.json`);
    expect(status.lastSuccessfulFetchAtMs).toBeGreaterThanOrEqual(before);
    expect(status.lastSuccessfulFetchAtMs).toBeLessThanOrEqual(after);
  });

  it('records the HTTP status when latest.json returns a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 503)));

    await expect(db.connectRemoteManifest(baseUrl)).rejects.toThrow(/HTTP 503/);
    expect(db.getSyncStatus()).toMatchObject({
      latestFetchStatus: 503,
      status: 'bundled',
      baseUrl,
    });
  });

  it('records the HTTP status when manifest.json returns a non-2xx response', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/datasets/latest.json')) return jsonResponse(latest('2.0.0'));
      if (url.endsWith('/datasets/v2.0.0/manifest.json')) return jsonResponse({ error: 'nope' }, 503);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(db.connectRemoteManifest(baseUrl)).rejects.toThrow(/HTTP 503/);
    expect(db.getSyncStatus()).toMatchObject({
      latestFetchStatus: 'ok',
      manifestUrl: `${baseUrl}/datasets/v2.0.0/manifest.json`,
      manifestFetchStatus: 503,
      status: 'bundled',
      baseUrl,
    });
  });

  it('records latestFetchStatus as failed when latest.json fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));

    await expect(db.connectRemoteManifest(baseUrl)).rejects.toThrow('Load failed');
    expect(db.getSyncStatus()).toMatchObject({
      latestFetchStatus: 'failed',
      status: 'bundled',
      baseUrl,
    });
  });

  it('records lastTileUrl and lastTileFetchStatus together from the tile that settled last', async () => {
    const latitude = 35.6812;
    const longitude = 139.7671;
    const coverageCells = new H3Tiler(6).coverageCellIds(latitude, longitude, 1);
    expect(coverageCells.length).toBeGreaterThan(1);

    const delayedCell = coverageCells[0];
    const delayedUrl = `${baseUrl}/datasets/v2.0.0/h3/6/${delayedCell}.json`;
    let releaseDelayed!: () => void;
    const delayedGate = new Promise<void>((resolve) => {
      releaseDelayed = resolve;
    });
    const settled: Array<{ url: string; status: 'ok' | 404 }> = [];

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/datasets/latest.json')) return jsonResponse(latest('2.0.0'));
      if (url.endsWith('/datasets/v2.0.0/manifest.json')) return jsonResponse(manifest('2.0.0'));
      if (url.includes('/h3/6/')) {
        const requestedCell = url.match(/\/([^/]+)\.json$/)?.[1];
        if (requestedCell === delayedCell) {
          await delayedGate;
          settled.push({ url, status: 404 });
          return jsonResponse({}, 404);
        }
        settled.push({ url, status: 'ok' });
        return jsonResponse({
          cellId: requestedCell,
          resolution: 6,
          lines: [{ id: `remote-${requestedCell}`, operatorId: 'remote', name: `Remote ${requestedCell}` }],
          routes: [],
          stations: [],
          segments: [],
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await db.connectRemoteManifest(baseUrl);
    const coverage = db.ensureCoverageAround(latitude, longitude);
    await vi.waitFor(() => {
      expect(settled.length).toBe(coverageCells.length - 1);
    });
    releaseDelayed();
    await coverage;

    const lastSettled = settled[settled.length - 1];
    expect(lastSettled).toEqual({ url: delayedUrl, status: 404 });
    expect(db.getSyncStatus()).toMatchObject({
      lastTileUrl: delayedUrl,
      lastTileFetchStatus: 404,
    });
  });

  it('preserves tile fetch diagnostics after a later manifest reconnect failure', async () => {
    const cellId = new H3Tiler(6).latLonToCellId(35.6812, 139.7671);
    let failNextLatest = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/datasets/latest.json')) {
        if (failNextLatest) throw new TypeError('Load failed');
        return jsonResponse(latest('2.0.0'));
      }
      if (url.endsWith('/datasets/v2.0.0/manifest.json')) return jsonResponse(manifest('2.0.0'));
      if (url.includes('/h3/6/')) {
        const requestedCell = url.match(/\/([^/]+)\.json$/)?.[1];
        if (requestedCell !== cellId) return jsonResponse({}, 404);
        return jsonResponse({
          cellId,
          resolution: 6,
          lines: [{ id: 'remote-2.0.0', operatorId: 'remote', name: 'Remote 2.0.0' }],
          routes: [],
          stations: [],
          segments: [],
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await db.connectRemoteManifest(baseUrl);
    await db.ensureCoverageAround(35.6812, 139.7671);
    const afterTile = db.getSyncStatus();
    const cellFromUrl = afterTile.lastTileUrl?.match(/\/h3\/6\/([^/]+)\.json$/)?.[1];
    expect(cellFromUrl).toEqual(expect.any(String));
    expect(afterTile.lastTileUrl).toBe(`${baseUrl}/datasets/v2.0.0/h3/6/${cellFromUrl}.json`);
    expect(afterTile.lastTileFetchStatus).toBe(cellFromUrl === cellId ? 'ok' : 404);
    expect(afterTile.lastSuccessfulFetchAtMs).toEqual(expect.any(Number));

    failNextLatest = true;
    await expect(db.connectRemoteManifest(baseUrl)).rejects.toThrow('Load failed');

    const afterFail = db.getSyncStatus();
    expect(afterFail.lastTileUrl).toBe(afterTile.lastTileUrl);
    expect(afterFail.lastTileFetchStatus).toBe(afterTile.lastTileFetchStatus);
    expect(afterFail.lastSuccessfulFetchAtMs).toBe(afterTile.lastSuccessfulFetchAtMs);
    expect(afterFail.latestFetchStatus).toBe('failed');
  });

  it('keeps fetch diagnostics when initialize handles a remote connect failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
    const remoteDb = new DexieRailwayDatabase({
      databaseName: `RailGlanceTest-${crypto.randomUUID()}`,
      remoteBaseUrl: baseUrl,
    });

    try {
      await remoteDb.initialize();
      await vi.waitFor(() => {
        expect(remoteDb.getSyncStatus().latestFetchStatus).toBe('failed');
      });
      expect(remoteDb.getSyncStatus()).toMatchObject({
        status: 'bundled',
        baseUrl,
        latestFetchStatus: 'failed',
      });
    } finally {
      await remoteDb.delete();
    }
  });
});
