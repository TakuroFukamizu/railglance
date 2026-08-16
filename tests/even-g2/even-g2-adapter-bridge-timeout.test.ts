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
import { resetBridgeHandshakeForTests } from '../../src/infrastructure/even-app/bridge-ready';

/** Let pending timers and the microtask queue settle. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('HybridEvenG2Adapter bridge-ready timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBridgeHandshakeForTests();
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
    // The handshake outlives the attempt that timed out, so a bridge arriving
    // during backoff resolves it and the next attempt picks it up.
    let deliverBridge!: (bridge: unknown) => void;
    sdk.waitForEvenAppBridge.mockReturnValue(
      new Promise((resolve) => { deliverBridge = resolve; })
    );
    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: 20 });

    expect(await adapter.connect()).toBe(false);

    deliverBridge(sdk.bridge);
    expect(await adapter.connect()).toBe(true);
    expect(adapter.isBridgeConnected()).toBe(true);
    expect(sdk.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it('reuses one SDK handshake across retries instead of stranding a listener', async () => {
    sdk.waitForEvenAppBridge.mockReturnValue(new Promise(() => {}));
    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: 20 });

    expect(await adapter.connect()).toBe(false);
    expect(await adapter.connect()).toBe(false);
    expect(await adapter.connect()).toBe(false);

    // Each SDK call registers a one-shot `evenAppBridgeReady` listener that it
    // cannot take back, so one call must cover all three attempts.
    expect(sdk.waitForEvenAppBridge).toHaveBeenCalledTimes(1);
  });

  it('does not cache a handshake that rejected', async () => {
    sdk.waitForEvenAppBridge.mockRejectedValueOnce(new Error('bridge init failed'));
    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: 20 });

    expect(await adapter.connect()).toBe(false);

    // A failed handshake must not be replayed forever: ask the SDK again.
    sdk.waitForEvenAppBridge.mockResolvedValue(sdk.bridge);
    expect(await adapter.connect()).toBe(true);
    expect(sdk.waitForEvenAppBridge).toHaveBeenCalledTimes(2);
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
    const timeoutMs = 60_000;

    // Track the handle of the timer armed for THIS bound. Asserting only that
    // clearTimeout was called would pass even if the handle were lost, since
    // `finally { clearTimeout(timer) }` runs either way.
    const armed: Array<ReturnType<typeof setTimeout>> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, delay?: number, ...rest: any[]) => {
      const handle = realSetTimeout(fn, delay as any, ...rest);
      if (delay === timeoutMs) armed.push(handle);
      return handle;
    }) as typeof globalThis.setTimeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: timeoutMs });
    expect(await adapter.connect()).toBe(true);

    expect(armed).toHaveLength(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(armed[0]);
  });
});

/**
 * `setTimeout` never rejects a bad delay — it silently substitutes ~1ms, so
 * `Infinity`, `NaN`, `0` and negatives all fire on the next tick. An
 * unvalidated option therefore does not reinstate the unbounded wait; it does
 * the reverse, expiring the handshake before the bridge can ever answer and
 * leaving the adapter permanently unable to connect. These assert the delay
 * actually handed to the timer, which costs no wall-clock time and leaves no
 * live timer behind.
 */
describe('HybridEvenG2Adapter bridgeReadyTimeoutMs validation', () => {
  /**
   * Counts only the option-validation warnings; unrelated bridge chatter (e.g. a
   * background speed-image flush) also lands on console.warn during connect().
   */
  function boundWarnings(warn: { mock: { calls: unknown[][] } }): unknown[][] {
    return warn.mock.calls.filter((args) => String(args[0]).includes('bridgeReadyTimeoutMs'));
  }

  const invalidBounds: Array<[string, number]> = [
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['zero', 0],
    ['a negative value', -1],
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    resetBridgeHandshakeForTests();
    sdk.bridge.createStartUpPageContainer.mockResolvedValue('success');
    sdk.bridge.onEvenHubEvent.mockImplementation(() => vi.fn());
    sdk.waitForEvenAppBridge.mockResolvedValue(sdk.bridge);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(invalidBounds)('falls back to the default bound when given %s', async (_label, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: value });
    expect(await adapter.connect()).toBe(true);

    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      DEFAULT_BRIDGE_READY_TIMEOUT_MS
    );
    // An overridden option is silently dropped otherwise; say so.
    expect(boundWarnings(warn)).toHaveLength(1);
  });

  it('clamps a bound past the 32-bit timer limit instead of overflowing to ~1ms', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    // Finite and positive, so a Number.isFinite-only guard would let it through,
    // yet setTimeout fires it after ~1ms.
    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: 2 ** 31 });
    expect(await adapter.connect()).toBe(true);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647);
    expect(boundWarnings(warn)).toHaveLength(1);
  });

  it('passes a valid bound through untouched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const adapter = new HybridEvenG2Adapter(undefined, { bridgeReadyTimeoutMs: 1234 });
    expect(await adapter.connect()).toBe(true);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1234);
    expect(boundWarnings(warn)).toHaveLength(0);
  });

  it('uses the default when no bound is supplied', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const adapter = new HybridEvenG2Adapter();
    expect(await adapter.connect()).toBe(true);

    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      DEFAULT_BRIDGE_READY_TIMEOUT_MS
    );
  });
});
