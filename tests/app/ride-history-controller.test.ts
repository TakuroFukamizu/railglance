import { describe, expect, it, vi } from 'vitest';
import { createRideHistoryController, type RideHistoryController } from '../../src/app/ride-history-controller';
import { DEFAULT_RIDE_HISTORY_CONFIG } from '../../src/config/ride-history-config';
import type { RideRecord } from '../../src/domain/history/ride-record';
import type { HudViewModel } from '../../src/domain/models/hud';
import type { EstimationLogEntry } from '../../src/infrastructure/logging/logger';
import { InMemoryRideHistoryStore } from '../../src/infrastructure/storage/ride-history-store';

const base = Date.UTC(2026, 8, 26);

function entry(seconds: number, overrides: Partial<EstimationLogEntry> = {}): EstimationLogEntry {
  const timestampMs = base + seconds * 1000;
  return {
    timestampMs,
    rawLocation: {
      latitude: 35.68 + seconds * 0.00018, longitude: 139.76,
      accuracyMeters: 10, timestampMs, speedMps: 20, headingDegrees: 0,
    },
    speedState: { isStopped: false, smoothedSpeedKmh: 72 } as EstimationLogEntry['speedState'],
    match: { lockState: 'LOCKED' } as EstimationLogEntry['match'],
    journey: {
      line: { id: 'L1', name: '山手線', operatorName: 'JR東日本' },
      directionName: '外回り', previousStation: { id: 'A', name: '東京' }, status: 'TRACKING',
    } as EstimationLogEntry['journey'],
    hudViewModel: {} as unknown as HudViewModel,
    ...overrides,
  };
}

function stream(controller: RideHistoryController, from: number, to: number, committed = true): void {
  for (let seconds = from; seconds <= to; seconds += 1) {
    controller.onTick(entry(seconds, committed ? {} : { match: null }));
  }
}

function record(id: string, overrides: Partial<RideRecord> = {}): RideRecord {
  return {
    recordVersion: 1, id, status: 'closed', lineId: 'L1', lineName: '山手線',
    operatorName: 'JR東日本', directionName: '外回り', fromStation: null,
    toStation: null, passedStations: [], startedAtMs: base - 300_000,
    endedAtMs: base - 120_000, endReason: 'route-lost', distanceMeters: 1000,
    maxSpeedKmh: 72, updatedAtMs: base - 120_000, ...overrides,
  };
}

function setup() {
  const store = new InMemoryRideHistoryStore();
  const clock = { now: base + 400_000 };
  const onError = vi.fn();
  const controller = createRideHistoryController({ store, now: () => clock.now, onError });
  return { store, clock, onError, controller };
}

// In-memory operations settle within the microtask queue; a new task also lets
// Vitest observe any unhandled rejection without adding a controller-only API.
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('ride history controller', () => {
  it('persists an open ride at promotion and closes it after losing the route', async () => {
    const { controller, store } = setup();
    await controller.start();
    stream(controller, 0, 30);
    await settle();
    const [open] = await store.findOpen();
    expect(open).toMatchObject({ status: 'open', startedAtMs: base, updatedAtMs: base + 30_000 });
    expect(controller.getRecent()).toEqual([]);

    stream(controller, 31, 180);
    stream(controller, 181, 362, false);
    await settle();
    const closed = await store.get(open.id);
    expect(closed).toMatchObject({ status: 'closed', endReason: 'route-lost', endedAtMs: base + 180_000 });
    expect(closed!.distanceMeters).toBeGreaterThan(500);
    expect(await store.findOpen()).toEqual([]);
    expect(controller.getRecent()).toEqual([closed]);
    controller.getRecent().pop();
    expect(controller.getRecent()).toEqual([closed]);
  });

  it('replays the cache synchronously, notifies on close, and supports unsubscribe', async () => {
    const { controller, store } = setup();
    const previous = record('previous');
    await store.put(previous);
    await controller.start();
    const listener = vi.fn();
    const otherListener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.subscribe(otherListener);
    expect(listener.mock.calls).toEqual([[[previous]]]);
    stream(controller, 0, 180);
    stream(controller, 181, 362, false);
    await settle();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(controller.getRecent());
    expect(otherListener).toHaveBeenCalledTimes(2);
    unsubscribe();
    await controller.clearAll();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(otherListener).toHaveBeenLastCalledWith([]);
  });

  it('finalizes dangling records at their update time and removes short ones on start', async () => {
    const { controller, store } = setup();
    const open = record('valid', { status: 'open', endedAtMs: null, endReason: null });
    await store.put(open);
    await store.put(record('short-duration', { ...open, id: 'short-duration', updatedAtMs: base - 250_000 }));
    await store.put(record('short-distance', { ...open, id: 'short-distance', distanceMeters: 499 }));
    const listener = vi.fn();
    controller.subscribe(listener);
    await controller.start();
    const closed = { ...open, status: 'closed', endReason: 'app-restart', endedAtMs: open.updatedAtMs };
    expect(await store.get('valid')).toEqual(closed);
    expect(await store.get('short-duration')).toBeUndefined();
    expect(await store.get('short-distance')).toBeUndefined();
    expect(controller.getRecent()).toEqual([closed]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith([closed]);
  });

  it('reports a single rejected put and continues persisting subsequent ticks without losing the cache', async () => {
    const { controller, store, onError } = setup();
    const previous = record('previous');
    await store.put(previous);
    await controller.start();
    const error = new Error('Storage full');
    vi.spyOn(store, 'put').mockRejectedValueOnce(error);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      stream(controller, 0, 30);
      await settle();
      expect(onError.mock.calls).toEqual([[error, 'ride-history-persist']]);
      expect(await store.findOpen()).toEqual([]);
      expect(controller.getRecent()).toEqual([previous]);
      // A station change makes the very next tick emit a new persist effect.
      const next = entry(31);
      next.journey.previousStation = { id: 'B', name: '神田' } as typeof next.journey.previousStation;
      controller.onTick(next);
      await settle();
      expect(await store.findOpen()).toEqual([expect.objectContaining({ updatedAtMs: base + 31_000 })]);
      expect(controller.getRecent()).toEqual([previous]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('removes individual rides and clears all records before resolving and notifying', async () => {
    const { controller, store } = setup();
    const first = record('first');
    const second = record('second', { startedAtMs: base - 400_000 });
    await store.put(first);
    await store.put(second);
    await controller.start();
    const listener = vi.fn();
    controller.subscribe(listener);
    await controller.removeRide(first.id);
    expect(await store.get(first.id)).toBeUndefined();
    expect(controller.getRecent()).toEqual([second]);
    expect(listener).toHaveBeenLastCalledWith([second]);
    await store.put(record('open', { status: 'open', endedAtMs: null, endReason: null }));
    await controller.clearAll();
    expect(await store.listAll()).toEqual([]);
    expect(await store.findOpen()).toEqual([]);
    expect(controller.getRecent()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith([]);
  });

  it('exports all closed records newest first even when they are absent from the cache', async () => {
    const { controller, store } = setup();
    const older = record('older');
    const newer = record('newer', { startedAtMs: base });
    await store.put(older);
    await store.put(record('open', { status: 'open', endedAtMs: null, endReason: null }));
    await store.put(newer);
    expect(controller.getRecent()).toEqual([]);
    expect(await controller.exportAll()).toEqual([newer, older]);
  });

  it('queues tick effects behind pending startup and preserves their order', async () => {
    const { controller, store } = setup();
    const dangling = record('dangling', { status: 'open', endedAtMs: null, endReason: null });
    await store.put(dangling);
    let release!: (rides: RideRecord[]) => void;
    const blocked = new Promise<RideRecord[]>((resolve) => { release = resolve; });
    vi.spyOn(store, 'findOpen').mockReturnValueOnce(blocked);
    const put = vi.spyOn(store, 'put');
    const listener = vi.fn();
    controller.subscribe(listener);
    const started = controller.start();
    stream(controller, 0, 180);
    stream(controller, 181, 362, false);
    await settle();
    expect(put).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    release([dangling]);
    await started;
    await settle();
    expect(put.mock.calls.map(([ride]) => [ride.status, ride.updatedAtMs - base])).toEqual([
      ['closed', -120_000], ['open', 30_000], ['open', 60_000], ['open', 90_000],
      ['open', 120_000], ['open', 150_000], ['open', 180_000], ['closed', 361_000],
    ]);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(controller.getRecent().map((ride) => ride.endReason)).toEqual(['route-lost', 'app-restart']);
  });

  it('discards a ride shorter than two minutes by removing its persisted open record', async () => {
    const { controller, store } = setup();
    await controller.start();
    const listener = vi.fn();
    controller.subscribe(listener);
    stream(controller, 0, 60);
    await settle();
    const [open] = await store.findOpen();
    expect(open.distanceMeters).toBeGreaterThan(500);
    stream(controller, 61, 242, false);
    await settle();
    expect(await store.get(open.id)).toBeUndefined();
    expect(await store.findOpen()).toEqual([]);
    expect(controller.getRecent()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('uses configured retention and record limits on startup and close', async () => {
    const store = new InMemoryRideHistoryStore();
    let now = base;
    const controller = createRideHistoryController({
      store, now: () => now,
      config: { ...DEFAULT_RIDE_HISTORY_CONFIG, retentionMs: 1_000_000, maxRecords: 2 },
    });
    await store.put(record('expired', { startedAtMs: base - 1_000_001 }));
    await store.put(record('overflow', { startedAtMs: base - 900_000 }));
    const first = record('first', { startedAtMs: base - 700_000 });
    const second = record('second');
    await store.put(first);
    await store.put(second);
    await controller.start();
    expect(await store.listAll()).toEqual([second, first]);
    now = base + 400_000;
    stream(controller, 0, 180);
    stream(controller, 181, 362, false);
    await settle();
    expect(await store.get('first')).toBeUndefined();
    expect(controller.getRecent().map((ride) => ride.startedAtMs)).toEqual([base, second.startedAtMs]);
  });

  it.each([
    ['start', 'ride-history-start'],
    ['removeRide', 'ride-history-remove'],
    ['clearAll', 'ride-history-clear'],
  ] as const)('preserves the cache and resolves when %s cannot refresh it', async (action, context) => {
    const { controller, store, onError } = setup();
    const previous = record('previous');
    await store.put(previous);
    await controller.start();
    const listener = vi.fn();
    controller.subscribe(listener);
    const error = new Error('Read failed');
    vi.spyOn(store, 'listRecent').mockRejectedValueOnce(error);
    await expect(controller[action]('previous')).resolves.toBeUndefined();
    expect(onError.mock.calls).toEqual([[error, context]]);
    expect(controller.getRecent()).toEqual([previous]);
    expect(listener).toHaveBeenCalledTimes(1);
    await controller.clearAll();
    expect(controller.getRecent()).toEqual([]);
    expect(listener).toHaveBeenLastCalledWith([]);
  });

  it.each([
    [180, 'ride-history-close'],
    [60, 'ride-history-discard'],
  ] as const)('reports %s-second ride finalization failures and keeps the queue usable', async (duration, context) => {
    const { controller, store, onError } = setup();
    const previous = record('previous');
    await store.put(previous);
    await controller.start();
    stream(controller, 0, duration);
    await settle();
    const error = new Error('Write failed');
    if (duration === 180) vi.spyOn(store, 'put').mockRejectedValueOnce(error);
    else vi.spyOn(store, 'remove').mockRejectedValueOnce(error);
    stream(controller, duration + 1, duration + 182, false);
    await settle();
    expect(onError.mock.calls).toEqual([[error, context]]);
    expect(controller.getRecent()).toEqual([previous]);
    await controller.clearAll();
    expect(controller.getRecent()).toEqual([]);
  });
});
