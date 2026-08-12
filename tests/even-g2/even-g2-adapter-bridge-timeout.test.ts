import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  bridge: {
    createStartUpPageContainer: vi.fn(),
    rebuildPageContainer: vi.fn(),
    updateImageRawData: vi.fn(),
    textContainerUpgrade: vi.fn(),
    shutDownPageContainer: vi.fn(),
    onEvenHubEvent: vi.fn(),
  },
  waitForEvenAppBridge: vi.fn(),
}));

vi.mock('@evenrealities/even_hub_sdk', () => {
  class Model {
    constructor(data: Record<string, unknown>) { Object.assign(this, data); }
  }
  return {
    waitForEvenAppBridge: sdk.waitForEvenAppBridge,
    ImageContainerProperty: Model,
    ImageRawDataUpdate: Model,
    TextContainerProperty: Model,
    TextContainerUpgrade: Model,
    CreateStartUpPageContainer: Model,
    RebuildPageContainer: Model,
    StartUpPageCreateResult: { success: 'success' },
    ImageRawDataUpdateResult: { isSuccess: (value: string) => value === 'success' },
    OsEventTypeList: {
      FOREGROUND_ENTER_EVENT: 4,
      FOREGROUND_EXIT_EVENT: 5,
      ABNORMAL_EXIT_EVENT: 6,
      SYSTEM_EXIT_EVENT: 7,
    },
  };
});

vi.mock('../../src/infrastructure/even-g2/speed-png-generator', () => ({
  createSpeedPng: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

import {
  DEFAULT_BRIDGE_READY_TIMEOUT_MS,
  HybridEvenG2Adapter,
} from '../../src/infrastructure/even-g2/even-g2-adapter';

/** Let pending timers and the microtask queue settle. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('HybridEvenG2Adapter bridge-ready timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.bridge.createStartUpPageContainer.mockResolvedValue('success');
    sdk.bridge.updateImageRawData.mockResolvedValue('success');
    sdk.bridge.textContainerUpgrade.mockResolvedValue(true);
    sdk.bridge.onEvenHubEvent.mockImplementation(() => vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to a bounded wait rather than an unlimited one', () => {
    expect(DEFAULT_BRIDGE_READY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_BRIDGE_READY_TIMEOUT_MS)).toBe(true);
  });

  it('gives up when the bridge never becomes ready, instead of hanging forever', async () => {
    // The SDK waits for an `evenAppBridgeReady` event that never arrives.
    sdk.waitForEvenAppBridge.mockReturnValue(new Promise(() => {}));

    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: 20 });

    // Without a timeout this await never settles and the test times out.
    await expect(adapter.connect()).resolves.toBe(false);

    expect(adapter.isBridgeConnected()).toBe(false);
    // The page must not be attempted when we never got a bridge.
    expect(sdk.bridge.createStartUpPageContainer).not.toHaveBeenCalled();
  });

  it('surfaces the timeout as an error so telemetry in connect() can capture it', async () => {
    sdk.waitForEvenAppBridge.mockReturnValue(new Promise(() => {}));
    const logged: unknown[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: 20 });
    await adapter.connect();

    const notice = logged.find(
      (args) =>
        Array.isArray(args) &&
        typeof args[0] === 'string' &&
        args[0].includes('Bridge connection notice')
    ) as unknown[] | undefined;
    expect(notice).toBeDefined();
    expect(notice?.[1]).toBeInstanceOf(Error);
    expect((notice?.[1] as Error).message).toMatch(/20 ?ms|timed out/i);
  });

  it('reconnects on a later attempt once the bridge becomes available', async () => {
    sdk.waitForEvenAppBridge.mockReturnValueOnce(new Promise(() => {}));
    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: 20 });

    expect(await adapter.connect()).toBe(false);

    // Bridge shows up before the AppController's next backoff attempt.
    sdk.waitForEvenAppBridge.mockResolvedValue(sdk.bridge);
    expect(await adapter.connect()).toBe(true);
    expect(adapter.isBridgeConnected()).toBe(true);
    expect(sdk.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it('does not raise an unhandled rejection when the abandoned wait rejects later', async () => {
    let rejectBridge!: (reason: Error) => void;
    sdk.waitForEvenAppBridge.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectBridge = reject;
      })
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: 20 });
      expect(await adapter.connect()).toBe(false);

      // The orphaned SDK promise settles well after we stopped waiting on it.
      rejectBridge(new Error('bridge channel torn down'));
      await wait(20);

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('clears the timeout timer once the bridge resolves normally', async () => {
    sdk.waitForEvenAppBridge.mockResolvedValue(sdk.bridge);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: 60_000 });
    expect(await adapter.connect()).toBe(true);

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
