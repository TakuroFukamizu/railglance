import { DEFAULT_RIDE_HISTORY_CONFIG, type RideHistoryConfig } from '../config/ride-history-config';
import type { RideRecord } from '../domain/history/ride-record';
import {
  createInitialRideRecorderState,
  finalizeDanglingRecord,
  reduceRideTick,
  toRideTick,
} from '../domain/history/ride-recorder';
import type { EstimationLogEntry } from '../infrastructure/logging/logger';
import type { RideHistoryStore } from '../infrastructure/storage/ride-history-store';

export type RideHistoryControllerDeps = {
  store: RideHistoryStore;
  config?: RideHistoryConfig;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
};

export type RideHistoryController = {
  start(): Promise<void>;
  onTick(entry: EstimationLogEntry): void;
  getRecent(): RideRecord[];
  subscribe(listener: (rides: RideRecord[]) => void): () => void;
  removeRide(id: string): Promise<void>;
  clearAll(): Promise<void>;
  exportAll(): Promise<RideRecord[]>;
};

export function createRideHistoryController(deps: RideHistoryControllerDeps): RideHistoryController {
  const { store, config = DEFAULT_RIDE_HISTORY_CONFIG, now = Date.now, onError } = deps;
  let state = createInitialRideRecorderState();
  let recent: RideRecord[] = [];
  let queue: Promise<void> = Promise.resolve();
  const listeners: Array<(rides: RideRecord[]) => void> = [];

  function enqueue(op: () => Promise<void>, context: string): Promise<void> {
    queue = queue.then(() => op()).catch((error: unknown) => onError?.(error, context));
    return queue;
  }

  function getRecent(): RideRecord[] {
    return [...recent];
  }

  async function refresh(): Promise<void> {
    recent = await store.listRecent(config.maxRecords);
    for (const listener of [...listeners]) listener(getRecent());
  }

  async function pruneAndRefresh(): Promise<void> {
    await store.prune(now() - config.retentionMs, config.maxRecords);
    await refresh();
  }

  return {
    start() {
      return enqueue(async () => {
        for (const record of await store.findOpen()) {
          const closed = finalizeDanglingRecord(record, config);
          if (closed === null) await store.remove(record.id);
          else await store.put(closed);
        }
        await pruneAndRefresh();
      }, 'ride-history-start');
    },

    onTick(entry) {
      const result = reduceRideTick(state, toRideTick(entry), config);
      state = result.state;
      for (const effect of result.effects) {
        switch (effect.type) {
          case 'persist':
            void enqueue(() => store.put(effect.record), 'ride-history-persist');
            break;
          case 'close':
            void enqueue(async () => {
              await store.put(effect.record);
              await pruneAndRefresh();
            }, 'ride-history-close');
            break;
          case 'discard':
            void enqueue(() => store.remove(effect.recordId), 'ride-history-discard');
            break;
        }
      }
    },

    getRecent,

    subscribe(listener) {
      // Each subscription has its own identity, even for the same callback.
      const subscription = (rides: RideRecord[]) => listener(rides);
      listeners.push(subscription);
      listener(getRecent());
      return () => {
        const index = listeners.indexOf(subscription);
        if (index !== -1) listeners.splice(index, 1);
      };
    },

    removeRide(id) {
      return enqueue(async () => {
        await store.remove(id);
        await refresh();
      }, 'ride-history-remove');
    },

    clearAll() {
      return enqueue(async () => {
        await store.clear();
        await refresh();
      }, 'ride-history-clear');
    },

    async exportAll() {
      return await store.listAll();
    },
  };
}
