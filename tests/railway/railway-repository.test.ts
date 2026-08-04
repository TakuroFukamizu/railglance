import { describe, it, expect, beforeEach } from 'vitest';
import { DexieRailwayDatabase } from '../../src/infrastructure/storage/dexie-railway-database';

describe('RailwayDataRepository & Schema v1.1.0', () => {
  let db: DexieRailwayDatabase;

  beforeEach(async () => {
    db = new DexieRailwayDatabase({ remoteBaseUrl: null });
    await db.initialize();
  });

  it('initializes with Schema v1.1.0 and provides RailwayDataState', async () => {
    const state = db.getDataState();
    expect(['bundled', 'cached', 'cloud', 'downloading', 'error']).toContain(state);

    const line = await db.getLine('odakyu-odawara');
    expect(line).toBeDefined();
    expect(line?.name).toContain('小田急');
  });

  it('finds segments near given coordinates via Repository interface', async () => {
    const segments = await db.findSegmentsNear(35.4526, 139.3900, 1000);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].lineId).toBe('odakyu-odawara');
  });

  it('fetches stations by line with sequence order', async () => {
    const stations = await db.getStationsByLine('odakyu-odawara');
    expect(stations.length).toBeGreaterThan(0);
    expect(stations[0].sequence).toBeLessThan(stations[1].sequence);
  });
});
