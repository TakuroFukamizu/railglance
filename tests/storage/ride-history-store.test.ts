import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RideRecord } from '../../src/domain/history/ride-record';
import {
  IndexedDbRideHistoryStore,
  InMemoryRideHistoryStore,
  type RideHistoryStore,
} from '../../src/infrastructure/storage/ride-history-store';

type StoreCase = {
  name: string;
  create: () => RideHistoryStore;
  destroy: (store: RideHistoryStore) => Promise<void>;
};

const cases: StoreCase[] = [
  {
    name: 'IndexedDbRideHistoryStore',
    create: () => new IndexedDbRideHistoryStore(`RailGlanceTest-${crypto.randomUUID()}`),
    destroy: async (store) => {
      await (store as IndexedDbRideHistoryStore).delete();
    },
  },
  {
    name: 'InMemoryRideHistoryStore',
    create: () => new InMemoryRideHistoryStore(),
    destroy: async () => {},
  },
];

function makeRecord(overrides: Partial<RideRecord> = {}): RideRecord {
  return {
    recordVersion: 1,
    id: 'ride-1',
    status: 'closed',
    lineId: 'line-a',
    lineName: '小田急線',
    operatorName: '小田急電鉄',
    directionName: '上り',
    fromStation: { id: 's1', name: '海老名' },
    toStation: { id: 's2', name: '相模大野' },
    passedStations: [
      { id: 's1', name: '海老名' },
      { id: 's2', name: '相模大野' },
    ],
    startedAtMs: 1_000,
    endedAtMs: 200_000,
    endReason: 'stopped',
    distanceMeters: 1234,
    maxSpeedKmh: 80,
    updatedAtMs: 200_000,
    ...overrides,
  };
}

describe.each(cases)('$name', ({ create, destroy }) => {
  let store: RideHistoryStore;

  beforeEach(() => {
    store = create();
  });

  afterEach(async () => {
    await destroy(store);
  });

  it('put then get returns the stored record', async () => {
    const record = makeRecord({ id: 'r1' });
    await store.put(record);
    expect(await store.get('r1')).toEqual(record);
  });

  it('get returns undefined for an unknown id', async () => {
    expect(await store.get('missing')).toBeUndefined();
  });

  it('put with the same id overwrites the previous record', async () => {
    await store.put(makeRecord({ id: 'r1', distanceMeters: 100, lineName: '小田急線' }));
    await store.put(makeRecord({ id: 'r1', distanceMeters: 2500, lineName: '別の線' }));
    const stored = await store.get('r1');
    expect(stored?.distanceMeters).toBe(2500);
    expect(stored?.lineName).toBe('別の線');
  });

  it('put does not mutate the input record and later input mutation does not leak into the store', async () => {
    const record = makeRecord({
      id: 'r1',
      passedStations: [{ id: 's1', name: '海老名' }],
    });
    const passedBefore = record.passedStations.map((station) => ({ ...station }));
    const lineNameBefore = record.lineName;
    const distanceBefore = record.distanceMeters;

    await store.put(record);

    expect(record.lineName).toBe(lineNameBefore);
    expect(record.distanceMeters).toBe(distanceBefore);
    expect(record.passedStations).toEqual(passedBefore);

    record.lineName = '改名';
    record.distanceMeters = 9_999;
    record.status = 'open';
    record.passedStations.push({ id: 's9', name: '新宿' });

    const stored = await store.get('r1');
    expect(stored).toMatchObject({
      id: 'r1',
      lineName: '小田急線',
      distanceMeters: 1234,
      status: 'closed',
      passedStations: [{ id: 's1', name: '海老名' }],
    });

    stored!.lineName = '読み出し後';
    stored!.passedStations.push({ id: 's8', name: '町田' });
    const reread = await store.get('r1');
    expect(reread?.lineName).toBe('小田急線');
    expect(reread?.passedStations).toEqual([{ id: 's1', name: '海老名' }]);
  });

  it('findOpen returns only open records', async () => {
    await store.put(makeRecord({ id: 'c1', startedAtMs: 300 }));
    await store.put(makeRecord({ id: 'o2', status: 'open', startedAtMs: 200, endedAtMs: null, endReason: null }));
    await store.put(makeRecord({ id: 'o1', status: 'open', startedAtMs: 100, endedAtMs: null, endReason: null }));
    await store.put(makeRecord({ id: 'c2', startedAtMs: 400 }));
    const openIds = (await store.findOpen()).map((record) => record.id).sort();
    expect(openIds).toEqual(['o1', 'o2']);
  });

  it('listRecent returns only closed records in startedAtMs descending order', async () => {
    await store.put(makeRecord({ id: 'r2', startedAtMs: 2_000 }));
    await store.put(makeRecord({ id: 'r1', startedAtMs: 1_000 }));
    await store.put(
      makeRecord({ id: 'open-1', status: 'open', startedAtMs: 9_000, endedAtMs: null, endReason: null }),
    );
    await store.put(makeRecord({ id: 'r3', startedAtMs: 3_000 }));
    const list = await store.listRecent(10);
    expect(list.map((record) => record.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('listRecent respects the limit', async () => {
    await store.put(makeRecord({ id: 'r2', startedAtMs: 2_000 }));
    await store.put(makeRecord({ id: 'r1', startedAtMs: 1_000 }));
    await store.put(makeRecord({ id: 'r3', startedAtMs: 3_000 }));
    const list = await store.listRecent(2);
    expect(list.map((record) => record.id)).toEqual(['r3', 'r2']);
  });

  it('listRecent excludes open records', async () => {
    await store.put(makeRecord({ id: 'c1', startedAtMs: 100 }));
    await store.put(
      makeRecord({ id: 'open-new', status: 'open', startedAtMs: 999_999, endedAtMs: null, endReason: null }),
    );
    await store.put(makeRecord({ id: 'c2', startedAtMs: 200 }));
    const list = await store.listRecent(10);
    expect(list.map((record) => record.id)).toEqual(['c2', 'c1']);
  });

  it('listAll returns all closed records in startedAtMs descending order', async () => {
    await store.put(makeRecord({ id: 'r2', startedAtMs: 2_000 }));
    await store.put(makeRecord({ id: 'r1', startedAtMs: 1_000 }));
    await store.put(
      makeRecord({ id: 'open-1', status: 'open', startedAtMs: 9_000, endedAtMs: null, endReason: null }),
    );
    await store.put(makeRecord({ id: 'r3', startedAtMs: 3_000 }));
    const list = await store.listAll();
    expect(list.map((record) => record.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('listAll excludes open records', async () => {
    await store.put(makeRecord({ id: 'c1', startedAtMs: 100 }));
    await store.put(
      makeRecord({ id: 'open-new', status: 'open', startedAtMs: 999_999, endedAtMs: null, endReason: null }),
    );
    await store.put(makeRecord({ id: 'c2', startedAtMs: 200 }));
    const list = await store.listAll();
    expect(list.map((record) => record.id)).toEqual(['c2', 'c1']);
  });

  it('remove deletes one record and leaves the others', async () => {
    await store.put(makeRecord({ id: 'r2', startedAtMs: 2_000 }));
    await store.put(makeRecord({ id: 'r1', startedAtMs: 1_000 }));
    await store.put(makeRecord({ id: 'r3', startedAtMs: 3_000 }));
    await store.remove('r2');
    expect((await store.listAll()).map((record) => record.id)).toEqual(['r3', 'r1']);
    expect(await store.get('r2')).toBeUndefined();
  });

  it('remove of an unknown id resolves without error', async () => {
    await store.put(makeRecord({ id: 'r1', startedAtMs: 1_000 }));
    await expect(store.remove('missing')).resolves.toBeUndefined();
    expect((await store.listAll()).map((record) => record.id)).toEqual(['r1']);
  });

  it('clear leaves listAll and findOpen empty', async () => {
    await store.put(makeRecord({ id: 'c1', startedAtMs: 1_000 }));
    await store.put(makeRecord({ id: 'o1', status: 'open', startedAtMs: 2_000, endedAtMs: null, endReason: null }));
    await store.clear();
    expect(await store.listAll()).toEqual([]);
    expect(await store.findOpen()).toEqual([]);
  });

  it('prune deletes closed records started before the cutoff and keeps one started exactly at the cutoff', async () => {
    await store.put(makeRecord({ id: 'newer', startedAtMs: 1_001 }));
    await store.put(makeRecord({ id: 'old', startedAtMs: 999 }));
    await store.put(makeRecord({ id: 'exact', startedAtMs: 1_000 }));
    await store.prune(1_000, 100);
    expect((await store.listAll()).map((record) => record.id)).toEqual(['newer', 'exact']);
  });

  it('prune keeps open records that are older than the cutoff', async () => {
    await store.put(
      makeRecord({ id: 'open-old', status: 'open', startedAtMs: 10, endedAtMs: null, endReason: null }),
    );
    await store.put(makeRecord({ id: 'closed-old', startedAtMs: 20 }));
    await store.put(makeRecord({ id: 'closed-new', startedAtMs: 2_000 }));
    await store.prune(1_000, 50);
    expect((await store.findOpen()).map((record) => record.id)).toEqual(['open-old']);
    expect((await store.listAll()).map((record) => record.id)).toEqual(['closed-new']);
  });

  it('prune trims closed records over maxRecords, oldest first', async () => {
    await store.put(makeRecord({ id: 'mid2', startedAtMs: 30 }));
    await store.put(makeRecord({ id: 'old', startedAtMs: 10 }));
    await store.put(makeRecord({ id: 'newest', startedAtMs: 40 }));
    await store.put(makeRecord({ id: 'mid1', startedAtMs: 20 }));
    await store.prune(0, 2);
    expect((await store.listAll()).map((record) => record.id)).toEqual(['newest', 'mid2']);
  });

  it('prune with exactly maxRecords closed records deletes nothing', async () => {
    await store.put(makeRecord({ id: 'a', startedAtMs: 300 }));
    await store.put(makeRecord({ id: 'b', startedAtMs: 100 }));
    await store.put(makeRecord({ id: 'c', startedAtMs: 200 }));
    await store.prune(0, 3);
    expect((await store.listAll()).map((record) => record.id)).toEqual(['a', 'c', 'b']);
  });

  it('prune counts only closed records against maxRecords', async () => {
    await store.put(makeRecord({ id: 'c2', startedAtMs: 200 }));
    await store.put(
      makeRecord({ id: 'open-old', status: 'open', startedAtMs: 50, endedAtMs: null, endReason: null }),
    );
    await store.put(makeRecord({ id: 'c1', startedAtMs: 100 }));
    await store.put(makeRecord({ id: 'c3', startedAtMs: 300 }));
    await store.prune(80, 2);
    expect((await store.listAll()).map((record) => record.id)).toEqual(['c3', 'c2']);
    expect((await store.findOpen()).map((record) => record.id)).toEqual(['open-old']);
  });

  it('close does not throw', () => {
    expect(() => store.close()).not.toThrow();
  });
});
