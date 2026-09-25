import { describe, expect, it } from 'vitest';
import sampleLines from '../../src/data/sample/lines.json';
import sampleMetadata from '../../src/data/sample/metadata.json';
import { DexieRailwayDatabase } from '../../src/infrastructure/storage/dexie-railway-database';

describe('bundled dataset', () => {
  // Issue #67 / #70: the bundled Shinkansen geometry was a 3-point straight line per
  // station pair, and 東京→上野 ran straight over the conventional corridor at 秋葉原.
  it('carries no Shinkansen geometry', () => {
    expect(sampleLines.filter((line) => line.name.includes('新幹線'))).toEqual([]);
  });

  it('reloads the bundled rows on a device holding an older bundled version', async () => {
    const databaseName = `RailGlanceTest-${crypto.randomUUID()}`;
    const lineId = sampleLines[0].id;

    const before = new DexieRailwayDatabase({ databaseName, remoteBaseUrl: null });
    await before.initialize();
    expect(await before.getLine(lineId)).toBeDefined();
    // A device that migrated the schema before the bundled data was corrected.
    await before.lines.delete(lineId);
    await before.datasetMetadata.update('current', { version: '0.0.1-stale' });
    before.close();

    const after = new DexieRailwayDatabase({ databaseName, remoteBaseUrl: null });
    await after.initialize();
    expect(await after.getLine(lineId)).toBeDefined();
    expect((await after.datasetMetadata.get('current'))?.version).toBe(sampleMetadata.version);
    after.close();
  });

  it('keeps the bundled rows when the bundled version is unchanged', async () => {
    const databaseName = `RailGlanceTest-${crypto.randomUUID()}`;
    const first = new DexieRailwayDatabase({ databaseName, remoteBaseUrl: null });
    await first.initialize();
    await first.lines.put({ id: 'user-edit-marker', operatorId: 'test', name: 'marker' });
    first.close();

    const second = new DexieRailwayDatabase({ databaseName, remoteBaseUrl: null });
    await second.initialize();
    expect(await second.getLine('user-edit-marker')).toBeDefined();
    second.close();
  });
});
