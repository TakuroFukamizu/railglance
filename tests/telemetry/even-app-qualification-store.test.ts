import { describe, expect, it, vi } from 'vitest';
import {
  EVEN_APP_QUALIFICATION_KEY,
  EvenAppCampaignQualificationStore,
  type EvenAppKeyValueStorage,
} from '../../src/infrastructure/telemetry/even-app-qualification-store';
import type {
  CampaignQualificationStore,
  StoredCampaignQualification,
} from '../../src/infrastructure/telemetry/qualification-store';

class MemoryQualificationStore implements CampaignQualificationStore {
  public value: StoredCampaignQualification | null = null;
  public closed = false;
  public async get(): Promise<StoredCampaignQualification | null> { return this.value; }
  public async set(value: StoredCampaignQualification): Promise<void> { this.value = structuredClone(value); }
  public async clear(): Promise<void> { this.value = null; }
  public close(): void { this.closed = true; }
}

class FakeBridgeStorage implements EvenAppKeyValueStorage {
  public values = new Map<string, string>();
  public async getLocalStorage(key: string): Promise<string> {
    // The native side answers an unknown key with an empty string.
    return this.values.get(key) ?? '';
  }
  public async setLocalStorage(key: string, value: string): Promise<boolean> {
    this.values.set(key, value);
    return true;
  }
}

function qualification(overrides: Partial<StoredCampaignQualification> = {}): StoredCampaignQualification {
  return {
    key: 'active', schemaVersion: 1, participantId: 'p_test', campaignId: 'campaign-test',
    credential: 'p_test.credential', qualificationExpiresAt: '2026-10-13T12:02:00.000Z',
    allowedReleases: ['0.1.*'], consentedAt: '2026-10-06T12:02:00.000Z', collectionEnabled: true,
    lastValidatedRelease: '0.1.6',
    ...overrides,
  };
}

function storeWith(bridge: EvenAppKeyValueStorage | Error, legacy = new MemoryQualificationStore()) {
  const connect = bridge instanceof Error
    ? vi.fn(async () => { throw bridge; })
    : vi.fn(async () => bridge);
  return { store: new EvenAppCampaignQualificationStore(connect, legacy), legacy, connect };
}

describe('EvenAppCampaignQualificationStore', () => {
  it('reads back a qualification written through the Even App storage after a restart', async () => {
    const bridge = new FakeBridgeStorage();
    await storeWith(bridge).store.set(qualification());

    // A relaunched WebView starts with empty web storage; only the bridge survives.
    const restarted = storeWith(bridge).store;

    await expect(restarted.get()).resolves.toEqual(qualification());
  });

  it('mirrors writes into the IndexedDB store', async () => {
    const { store, legacy } = storeWith(new FakeBridgeStorage());

    await store.set(qualification());

    expect(legacy.value).toEqual(qualification());
  });

  it('reports no qualification when nothing was stored', async () => {
    await expect(storeWith(new FakeBridgeStorage()).store.get()).resolves.toBeNull();
  });

  it('migrates a qualification that only the IndexedDB store still holds', async () => {
    const bridge = new FakeBridgeStorage();
    const legacy = new MemoryQualificationStore();
    legacy.value = qualification();

    await expect(storeWith(bridge, legacy).store.get()).resolves.toEqual(qualification());
    expect(JSON.parse(bridge.values.get(EVEN_APP_QUALIFICATION_KEY) ?? '')).toEqual(qualification());
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['a non-object', '"text"'],
    ['an unknown schema version', JSON.stringify({ ...qualification(), schemaVersion: 2 })],
    ['a missing credential', JSON.stringify({ ...qualification(), credential: undefined })],
    ['non-string releases', JSON.stringify({ ...qualification(), allowedReleases: [1] })],
  ])('treats %s as no qualification instead of throwing', async (_label, raw) => {
    const bridge = new FakeBridgeStorage();
    bridge.values.set(EVEN_APP_QUALIFICATION_KEY, raw);

    await expect(storeWith(bridge).store.get()).resolves.toBeNull();
  });

  it('treats a nullish bridge answer as no qualification', async () => {
    const bridge: EvenAppKeyValueStorage = {
      getLocalStorage: async () => undefined as unknown as string,
      setLocalStorage: async () => true,
    };

    await expect(storeWith(bridge).store.get()).resolves.toBeNull();
  });

  it('clears both the Even App storage and the IndexedDB store', async () => {
    const bridge = new FakeBridgeStorage();
    const { store, legacy } = storeWith(bridge);
    await store.set(qualification());

    await store.clear();

    expect(legacy.value).toBeNull();
    await expect(storeWith(bridge).store.get()).resolves.toBeNull();
  });

  it('falls back to the IndexedDB store when the bridge never becomes ready', async () => {
    const legacy = new MemoryQualificationStore();
    const { store } = storeWith(new Error('waitForEvenAppBridge() timed out'), legacy);

    await store.set(qualification());

    expect(legacy.value).toEqual(qualification());
    await expect(store.get()).resolves.toEqual(qualification());
    await expect(store.clear()).resolves.toBeUndefined();
    expect(legacy.value).toBeNull();
  });

  it('keeps the IndexedDB copy when the bridge refuses a write', async () => {
    const legacy = new MemoryQualificationStore();
    const bridge: EvenAppKeyValueStorage = {
      getLocalStorage: async () => '',
      setLocalStorage: async () => false,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await storeWith(bridge, legacy).store.set(qualification());

    expect(legacy.value).toEqual(qualification());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fails the clear when the bridge refuses to drop the qualification', async () => {
    const legacy = new MemoryQualificationStore();
    legacy.value = qualification();
    const bridge: EvenAppKeyValueStorage = {
      getLocalStorage: async () => JSON.stringify(qualification()),
      setLocalStorage: async () => false,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(storeWith(bridge, legacy).store.clear()).rejects.toThrow();
    expect(legacy.value).toBeNull();
    warn.mockRestore();
  });

  it('connects to the bridge only once', async () => {
    const { store, connect } = storeWith(new FakeBridgeStorage());

    await store.set(qualification());
    await store.get();
    await store.clear();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('closes the IndexedDB store', () => {
    const { store, legacy } = storeWith(new FakeBridgeStorage());

    store.close();

    expect(legacy.closed).toBe(true);
  });
});
