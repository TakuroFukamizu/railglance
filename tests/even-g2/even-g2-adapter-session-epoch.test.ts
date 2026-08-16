import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HudViewModel } from '../../src/domain/models/hud';

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

import { HybridEvenG2Adapter } from '../../src/infrastructure/even-g2/even-g2-adapter';

function viewModel(speed: string): HudViewModel {
  return {
    header: { lineName: '小田急線', serviceOrDirection: '上り' },
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

/**
 * A stale rebuild is one that was queued for session A but only reaches the
 * front of bridgeQueue after session A died and the reconnect loop established
 * session B. `isConnected` is true in both cases, so it cannot tell them apart.
 */
describe('HybridEvenG2Adapter stale recovery across a reconnect', () => {
  let hubEvent: ((event: any) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  /**
   * Drives the adapter into the exact interleaving from issue #32 and leaves the
   * stale rebuild parked behind a slow BLE text update.
   *
   * Returns a `releaseSlowOp` that lets the queue drain, at which point the
   * stale rebuild reaches the front.
   */
  async function parkStaleRebuildBehindSlowOp(): Promise<{
    adapter: HybridEvenG2Adapter;
    releaseSlowOp: () => void;
    secondConnect: Promise<boolean>;
  }> {
    const adapter = new HybridEvenG2Adapter();
    expect(await adapter.connect()).toBe(true); // session A

    // A slow BLE text update takes the queue and stays in flight.
    let releaseSlowOp!: () => void;
    sdk.bridge.textContainerUpgrade.mockImplementationOnce(
      () => new Promise((resolve) => { releaseSlowOp = () => resolve(true); })
    );
    await adapter.render(viewModel('80'));
    await flushBridge();

    // Foreground bounce queues a rebuild BEHIND the in-flight slow op.
    hubEvent?.({ sysEvent: { eventType: 5 } }); // FOREGROUND_EXIT
    hubEvent?.({ sysEvent: { eventType: 4 } }); // FOREGROUND_ENTER
    await flushBridge();
    expect(sdk.bridge.rebuildPageContainer).not.toHaveBeenCalled(); // still queued

    // Session A dies and the reconnect loop immediately establishes session B.
    // createStartUpPageContainer does NOT go through bridgeQueue, so session B
    // is live (isConnected === true) while connect()'s initial image push is
    // still queued behind the slow op — and behind the stale rebuild.
    hubEvent?.({ sysEvent: { eventType: 6 } }); // ABNORMAL_EXIT
    expect(adapter.isBridgeConnected()).toBe(false);
    const secondConnect = adapter.connect(); // session B — do not await yet
    await flushBridge();
    expect(adapter.isBridgeConnected()).toBe(true);
    expect(sdk.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(2);

    return { adapter, releaseSlowOp, secondConnect };
  }

  it('does not rebuild the page of a session it was not queued for', async () => {
    const { adapter, releaseSlowOp, secondConnect } = await parkStaleRebuildBehindSlowOp();

    releaseSlowOp();
    await flushBridge();
    expect(await secondConnect).toBe(true);

    // The rebuild belonged to session A, which no longer exists.
    expect(sdk.bridge.rebuildPageContainer).not.toHaveBeenCalled();
    expect(adapter.isBridgeConnected()).toBe(true);
  });

  it('does not tear down the reconnected session when the stale rebuild fails', async () => {
    const { adapter, releaseSlowOp, secondConnect } = await parkStaleRebuildBehindSlowOp();

    // Even if the native call would fail, session B must survive: a failure that
    // belongs to a dead session must not resolve session B's disconnect waiter.
    sdk.bridge.rebuildPageContainer.mockResolvedValue(false);
    let disconnected = false;
    void adapter.waitUntilDisconnected!().then(() => { disconnected = true; });

    releaseSlowOp();
    await flushBridge();
    expect(await secondConnect).toBe(true);

    expect(adapter.isBridgeConnected()).toBe(true);
    expect(disconnected).toBe(false);
  });

  it('still recovers normally when no reconnect happened in between', async () => {
    const adapter = new HybridEvenG2Adapter();
    expect(await adapter.connect()).toBe(true);
    await adapter.render(viewModel('80'));
    await flushBridge();

    hubEvent?.({ sysEvent: { eventType: 5 } }); // FOREGROUND_EXIT
    hubEvent?.({ sysEvent: { eventType: 4 } }); // FOREGROUND_ENTER
    await flushBridge();

    // Same session throughout, so the rebuild must actually run.
    expect(sdk.bridge.rebuildPageContainer).toHaveBeenCalledTimes(1);
    expect(adapter.isBridgeConnected()).toBe(true);
  });

  it('still disconnects when a rebuild fails within its own session', async () => {
    const adapter = new HybridEvenG2Adapter();
    expect(await adapter.connect()).toBe(true);
    sdk.bridge.rebuildPageContainer.mockResolvedValue(false);

    let disconnected = false;
    void adapter.waitUntilDisconnected!().then(() => { disconnected = true; });

    hubEvent?.({ sysEvent: { eventType: 5 } });
    hubEvent?.({ sysEvent: { eventType: 4 } });
    await flushBridge();

    expect(adapter.isBridgeConnected()).toBe(false);
    expect(disconnected).toBe(true);
  });
});
