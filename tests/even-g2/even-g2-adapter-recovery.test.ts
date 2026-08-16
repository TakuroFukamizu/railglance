import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HudViewModel } from '../../src/domain/models/hud';
import { AppController } from '../../src/app/app-controller';
import { DEFAULT_TRACKING_CONFIG } from '../../src/config/tracking-config';
import { EstimationLogger } from '../../src/infrastructure/logging/logger';

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

import { EvenG2Adapter, HybridEvenG2Adapter } from '../../src/infrastructure/even-g2/even-g2-adapter';

const FOREGROUND_EXIT = 5;
const FOREGROUND_ENTER = 4;

function viewModel(speed: string, lineName = '小田急線'): HudViewModel {
  return {
    header: { lineName, serviceOrDirection: '上り' },
    speed: { displaySpeedKmhText: speed, unitText: 'km/h', isEstimated: false },
    segment: {
      previousStationName: '海老名',
      nextStationName: '座間',
      progressRatio: 0.5,
      distanceToNextText: '次まで 1km',
    },
    footer: { leftInfo: '上り', statusRight: 'GPS' },
    statusMode: 'GPS',
    rawFormattedText: speed,
    timestampMs: 1000,
  };
}

/** Drain microtasks + any queued bridge flushes. */
async function flushBridge(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Observe a promise without hanging the test when it never settles. */
async function settle(promise: Promise<unknown>): Promise<'resolved' | 'pending'> {
  return Promise.race([
    promise.then(() => 'resolved' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
  ]);
}

describe('HybridEvenG2Adapter foreground recovery failure', () => {
  let hubEvent: ((event: any) => void) | undefined;
  let warn: ReturnType<typeof vi.spyOn>;
  let now = 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    sdk.waitForEvenAppBridge.mockResolvedValue(sdk.bridge);
    sdk.bridge.createStartUpPageContainer.mockResolvedValue('success');
    sdk.bridge.rebuildPageContainer.mockResolvedValue(true);
    sdk.bridge.updateImageRawData.mockResolvedValue('success');
    sdk.bridge.textContainerUpgrade.mockResolvedValue(true);
    sdk.bridge.shutDownPageContainer.mockResolvedValue(true);
    sdk.bridge.onEvenHubEvent.mockImplementation((callback) => {
      hubEvent = callback;
      return vi.fn();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connectedAdapter(): Promise<HybridEvenG2Adapter> {
    const adapter = new HybridEvenG2Adapter();
    expect(await adapter.connect()).toBe(true);
    now += 1000;
    await adapter.render(viewModel('80'));
    await flushBridge();
    return adapter;
  }

  it('transitions to disconnected when rebuildPageContainer returns false', async () => {
    const adapter = await connectedAdapter();
    // The waiter must be registered *before* the failure: that is the deadlock case.
    const disconnected = adapter.waitUntilDisconnected();

    sdk.bridge.rebuildPageContainer.mockResolvedValue(false);
    hubEvent?.({ sysEvent: { eventType: FOREGROUND_EXIT } });
    hubEvent?.({ sysEvent: { eventType: FOREGROUND_ENTER } });
    await flushBridge();

    expect(sdk.bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    expect(await settle(disconnected)).toBe('resolved');
    expect(adapter.isBridgeConnected()).toBe(false);

    // None of the rebuild side effects took: the HUD stays off the bridge.
    sdk.bridge.textContainerUpgrade.mockClear();
    now += 1000;
    await adapter.render(viewModel('88'));
    await flushBridge();
    expect(sdk.bridge.textContainerUpgrade).not.toHaveBeenCalled();
  });

  it('transitions to disconnected when rebuildPageContainer throws', async () => {
    const adapter = await connectedAdapter();
    const disconnected = adapter.waitUntilDisconnected();

    const rebuildError = new Error('native rebuild exploded');
    sdk.bridge.rebuildPageContainer.mockRejectedValue(rebuildError);
    hubEvent?.({ sysEvent: { eventType: FOREGROUND_EXIT } });
    hubEvent?.({ sysEvent: { eventType: FOREGROUND_ENTER } });
    await flushBridge();

    expect(await settle(disconnected)).toBe('resolved');
    expect(adapter.isBridgeConnected()).toBe(false);
    expect(warn).toHaveBeenCalledWith('[EvenG2Adapter] Page recovery failed:', rebuildError);
    // A late foreground event must not resurrect the dead session.
    hubEvent?.({ sysEvent: { eventType: FOREGROUND_ENTER } });
    await flushBridge();
    expect(sdk.bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    expect(adapter.isBridgeConnected()).toBe(false);
  });

  it('reconnects cleanly after a failed recovery', async () => {
    const adapter = await connectedAdapter();
    const disconnected = adapter.waitUntilDisconnected();

    sdk.bridge.rebuildPageContainer.mockResolvedValue(false);
    hubEvent?.({ sysEvent: { eventType: FOREGROUND_EXIT } });
    hubEvent?.({ sysEvent: { eventType: FOREGROUND_ENTER } });
    await flushBridge();
    expect(await settle(disconnected)).toBe('resolved');

    // AppController's reconnect loop calls connect() again.
    sdk.bridge.createStartUpPageContainer.mockClear();
    expect(await adapter.connect()).toBe(true);
    expect(sdk.bridge.createStartUpPageContainer).toHaveBeenCalledOnce();
    expect(adapter.isBridgeConnected()).toBe(true);

    // HUD updates reach the bridge again...
    sdk.bridge.textContainerUpgrade.mockClear();
    now += 1000;
    await adapter.render(viewModel('95', '中央線'));
    await flushBridge();
    expect(sdk.bridge.textContainerUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: 'header', content: expect.stringContaining('中央線') })
    );

    // ...and a fresh waiter stays pending until the next disconnect.
    const nextDisconnect = adapter.waitUntilDisconnected();
    expect(await settle(nextDisconnect)).toBe('pending');
  });
});

describe('AppController reconnect after a failed page recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reconnects once the adapter resolves its disconnect waiter, backing off on a failed attempt', async () => {
    let waiterCount = 0;
    let resolveDisconnect: () => void = () => {
      throw new Error('waitUntilDisconnected() was never awaited');
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(true) // initial connect
      .mockResolvedValueOnce(false) // first reconnect attempt fails -> backoff
      .mockResolvedValue(true); // recovers afterwards
    const adapter: EvenG2Adapter = {
      connect,
      render: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      getLastImageResult: () => 'none',
      isBridgeConnected: () => true,
      waitUntilDisconnected: () =>
        new Promise<void>((resolve) => {
          waiterCount++;
          resolveDisconnect = resolve;
        }),
    };

    const controller = new AppController(
      { start: vi.fn(), stop: vi.fn() },
      { match: vi.fn().mockResolvedValue(null), reset: vi.fn() } as any,
      { update: vi.fn(), reset: vi.fn() } as any,
      {} as any,
      adapter,
      new EstimationLogger(),
      // Park the HUD render tick so only the reconnect loop drives this test.
      { ...DEFAULT_TRACKING_CONFIG, hudRefreshMs: 1_000_000 }
    );

    await controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    // The loop parks on the adapter's disconnect waiter instead of reconnecting.
    expect(waiterCount).toBe(1);

    // Failed foreground recovery resolves the disconnect waiter.
    resolveDisconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);

    // That attempt failed, so the third one only lands after the backoff delay.
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connect).toHaveBeenCalledTimes(3);

    await controller.stop();
  });
});
