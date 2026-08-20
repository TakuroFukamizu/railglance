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
import { RECOVERY_HEALTH_RESET_MS } from '../../src/infrastructure/even-g2/bridge-operation';

const SHORT_TIMEOUTS = {
  textOperationTimeoutMs: 40,
  imageOperationTimeoutMs: 50,
  pageOperationTimeoutMs: 60,
  stallSettleGraceMs: 10,
};

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_500,
  stepMs = 5
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function neverSettling<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('HybridEvenG2Adapter transport watchdog', () => {
  let now = 1_000;

  beforeEach(() => {
    vi.clearAllMocks();
    now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    sdk.waitForEvenAppBridge.mockResolvedValue(sdk.bridge);
    sdk.bridge.createStartUpPageContainer.mockResolvedValue('success');
    sdk.bridge.rebuildPageContainer.mockResolvedValue(true);
    sdk.bridge.updateImageRawData.mockResolvedValue('success');
    sdk.bridge.textContainerUpgrade.mockResolvedValue(true);
    sdk.bridge.shutDownPageContainer.mockResolvedValue(true);
    sdk.bridge.onEvenHubEvent.mockImplementation(() => vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connectedAdapter(
    timeouts: Partial<typeof SHORT_TIMEOUTS> = SHORT_TIMEOUTS
  ): Promise<HybridEvenG2Adapter> {
    const adapter = new HybridEvenG2Adapter(undefined, timeouts);
    expect(await adapter.connect()).toBe(true);
    now += 1_000;
    return adapter;
  }

  it('recovers from a hung updateImageRawData and resends the newest ViewModel', async () => {
    const adapter = await connectedAdapter();
    await adapter.render(viewModel('80'));
    await flushBridge();

    sdk.bridge.updateImageRawData.mockReturnValue(neverSettling());
    sdk.bridge.textContainerUpgrade.mockClear();
    sdk.bridge.rebuildPageContainer.mockClear();

    const epochBefore = adapter.getBridgeDiagnostics().sessionEpoch;
    now += 1_000;
    await adapter.render(viewModel('90'));
    await flushBridge();

    await waitFor(() => adapter.getBridgeDiagnostics().operation.stalled);
    expect(adapter.getBridgeDiagnostics().pageReady).toBe(false);
    expect(adapter.getBridgeDiagnostics().sessionEpoch).toBeGreaterThan(epochBefore);

    await waitFor(() => sdk.bridge.rebuildPageContainer.mock.calls.length >= 1);
    await waitFor(() => adapter.getBridgeDiagnostics().status === 'CONNECTED');
    await flushBridge();

    const headerCalls = sdk.bridge.textContainerUpgrade.mock.calls.filter(
      ([update]) => update.containerName === 'header'
    );
    expect(headerCalls.length).toBeGreaterThan(0);
    expect(headerCalls.some(([update]) => String(update.content).includes('小田急線'))).toBe(true);
    expect(adapter.getBridgeDiagnostics().operation.stalled).toBe(false);
    expect(adapter.getBridgeDiagnostics().pageReady).toBe(true);
  });

  it.each([
    {
      containerName: 'header' as const,
      next: { ...viewModel('80', '中央線') },
      marker: '中央線',
    },
    {
      containerName: 'segment' as const,
      next: {
        ...viewModel('80'),
        segment: {
          ...viewModel('80').segment,
          previousStationName: '新宿',
          nextStationName: '四ツ谷',
        },
      },
      marker: '新宿',
    },
    {
      containerName: 'footer' as const,
      next: {
        ...viewModel('80'),
        segment: { ...viewModel('80').segment, distanceToNextText: '次まで 9km' },
        footer: { leftInfo: '上り', statusRight: 'DR' },
      },
      marker: '次まで 9km',
    },
  ])(
    'recovers when textContainerUpgrade hangs on $containerName',
    async ({ containerName, next, marker }) => {
      const adapter = await connectedAdapter();
      await adapter.render(viewModel('80', '小田急線'));
      await flushBridge();

      sdk.bridge.textContainerUpgrade.mockImplementation((update: { containerName: string }) => {
        if (update.containerName === containerName) return neverSettling();
        return Promise.resolve(true);
      });
      sdk.bridge.rebuildPageContainer.mockClear();

      const epochBefore = adapter.getBridgeDiagnostics().sessionEpoch;
      await adapter.render(next);
      await flushBridge();

      await waitFor(() => adapter.getBridgeDiagnostics().operation.stalled);
      expect(adapter.getBridgeDiagnostics().pageReady).toBe(false);
      expect(adapter.getBridgeDiagnostics().sessionEpoch).toBeGreaterThan(epochBefore);

      sdk.bridge.textContainerUpgrade.mockResolvedValue(true);
      await waitFor(() => sdk.bridge.rebuildPageContainer.mock.calls.length >= 1);
      await waitFor(() => adapter.getBridgeDiagnostics().status === 'CONNECTED');
      await flushBridge();

      const retryCalls = sdk.bridge.textContainerUpgrade.mock.calls.filter(
        ([update]) => update.containerName === containerName
      );
      expect(retryCalls.some(([update]) => String(update.content).includes(marker))).toBe(true);
      expect(adapter.getBridgeDiagnostics().operation.stalled).toBe(false);
    }
  );

  it('does not let a stale late completion overwrite the recovered session', async () => {
    const adapter = await connectedAdapter();
    await adapter.render(viewModel('80'));
    await flushBridge();

    let resolveHung!: (value: string) => void;
    sdk.bridge.updateImageRawData.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveHung = resolve; })
    );
    sdk.bridge.updateImageRawData.mockResolvedValue('success');

    now += 1_000;
    await adapter.render(viewModel('91'));
    await flushBridge();

    await waitFor(() => adapter.getBridgeDiagnostics().operation.stalled);
    await waitFor(() => adapter.getBridgeDiagnostics().status === 'CONNECTED');
    await flushBridge();

    const resultAfterRecovery = adapter.getLastImageResult();
    const speedAfterRecovery = adapter.getBridgeDiagnostics();

    resolveHung('stale-success');
    await flushBridge();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(adapter.getLastImageResult()).toBe(resultAfterRecovery);
    expect(adapter.getLastImageResult()).not.toBe('stale-success');
    expect(adapter.getBridgeDiagnostics().operation.lastResult).not.toBe('stale-success');
    expect(adapter.getBridgeDiagnostics().sessionEpoch).toBe(speedAfterRecovery.sessionEpoch);
    expect(adapter.getBridgeDiagnostics().operation.stalled).toBe(false);
  });

  it('keeps render() prompt and invokes onRender for every call while stalled', async () => {
    const previews: string[] = [];
    const adapter = new HybridEvenG2Adapter((text) => { previews.push(text); }, SHORT_TIMEOUTS);
    expect(await adapter.connect()).toBe(true);
    now += 1_000;

    sdk.bridge.updateImageRawData.mockReturnValue(neverSettling());
    await adapter.render(viewModel('70'));
    await flushBridge();
    await waitFor(() => adapter.getBridgeDiagnostics().operation.stalled);

    const started = Date.now();
    await adapter.render(viewModel('71'));
    await adapter.render(viewModel('72'));
    await adapter.render(viewModel('73'));
    expect(Date.now() - started).toBeLessThan(40);

    expect(previews).toEqual(['70', '71', '72', '73']);
    await waitFor(() => adapter.getBridgeDiagnostics().status === 'CONNECTED');
  });

  it('does not enqueue a BLE backlog of 100 renders during a stall', async () => {
    const adapter = await connectedAdapter();
    await adapter.render(viewModel('80'));
    await flushBridge();

    const imageCallsAtReady = sdk.bridge.updateImageRawData.mock.calls.length;
    const textCallsAtReady = sdk.bridge.textContainerUpgrade.mock.calls.length;

    sdk.bridge.updateImageRawData.mockReturnValue(neverSettling());
    // Keep recovery from completing so this snapshot stays in the stalled session.
    sdk.bridge.rebuildPageContainer.mockReturnValue(neverSettling());
    now += 1_000;
    await adapter.render(viewModel('81'));
    await flushBridge();
    await waitFor(() => adapter.getBridgeDiagnostics().operation.stalled);

    for (let i = 0; i < 100; i++) {
      await adapter.render(viewModel(String(82 + i)));
    }
    await flushBridge();

    const diagnostics = adapter.getBridgeDiagnostics();
    expect(diagnostics.hudFlushScheduled).toBe(false);
    expect(diagnostics.hudFlushInFlight).toBe(false);
    expect(diagnostics.hudDirty).toBe(true);
    // One hung image for the stalling flush; no extra image/text ops while stalled.
    expect(sdk.bridge.updateImageRawData.mock.calls.length - imageCallsAtReady).toBe(1);
    expect(sdk.bridge.textContainerUpgrade.mock.calls.length).toBe(textCallsAtReady);

    // Drain the hung recovery so its backoff cannot leak rebuilds into later tests.
    await adapter.waitUntilDisconnected();
  }, 10_000);

  it('pushes the newest model after recovery, not the one that was in flight', async () => {
    const adapter = await connectedAdapter();
    await adapter.render(viewModel('80', '小田急線'));
    await flushBridge();

    sdk.bridge.updateImageRawData.mockReturnValue(neverSettling());
    now += 1_000;
    await adapter.render(viewModel('81', '小田急線'));
    await flushBridge();
    await waitFor(() => adapter.getBridgeDiagnostics().operation.stalled);

    await adapter.render(viewModel('82', '山手線'));
    await adapter.render(viewModel('99', '中央線'));

    sdk.bridge.updateImageRawData.mockResolvedValue('success');
    sdk.bridge.textContainerUpgrade.mockClear();
    await waitFor(() => adapter.getBridgeDiagnostics().status === 'CONNECTED');
    await flushBridge();
    await waitFor(
      () =>
        sdk.bridge.textContainerUpgrade.mock.calls.some(
          ([update]) =>
            update.containerName === 'header' && String(update.content).includes('中央線')
        )
    );

    const headerContents = sdk.bridge.textContainerUpgrade.mock.calls
      .filter(([update]) => update.containerName === 'header')
      .map(([update]) => String(update.content));
    expect(headerContents.some((content) => content.includes('中央線'))).toBe(true);
    expect(headerContents.some((content) => content.includes('山手線'))).toBe(false);
  });

  it('escalates to disconnect when every recovery attempt also stalls', async () => {
    const adapter = await connectedAdapter();
    await adapter.render(viewModel('80'));
    await flushBridge();

    sdk.bridge.updateImageRawData.mockReturnValue(neverSettling());
    sdk.bridge.rebuildPageContainer.mockReturnValue(neverSettling());

    const disconnected = adapter.waitUntilDisconnected();
    now += 1_000;
    await adapter.render(viewModel('90'));
    await flushBridge();

    await expect(disconnected).resolves.toBeUndefined();
    expect(adapter.isBridgeConnected()).toBe(false);
    expect(adapter.getBridgeDiagnostics().status).toBe('DISCONNECTED');
    expect(adapter.getBridgeDiagnostics().recoveryCount).toBe(3);
    expect(sdk.bridge.rebuildPageContainer.mock.calls.length).toBe(3);
  }, 10_000);

  it('resets stallRecoveryFailures after a sustained healthy flush streak', async () => {
    const adapter = await connectedAdapter();
    await adapter.render(viewModel('80'));
    await flushBridge();

    sdk.bridge.updateImageRawData.mockReturnValue(neverSettling());
    sdk.bridge.rebuildPageContainer.mockRejectedValue(new Error('rebuild failed'));

    const disconnected = adapter.waitUntilDisconnected();
    now += 1_000;
    await adapter.render(viewModel('90'));
    await flushBridge();
    await disconnected;

    expect(adapter.getBridgeDiagnostics().stallRecoveryFailures).toBe(3);

    sdk.bridge.updateImageRawData.mockResolvedValue('success');
    sdk.bridge.rebuildPageContainer.mockResolvedValue(true);
    expect(await adapter.connect()).toBe(true);

    await adapter.render(viewModel('91'));
    await flushBridge();
    expect(adapter.getBridgeDiagnostics().stallRecoveryFailures).toBe(3);

    now += RECOVERY_HEALTH_RESET_MS;
    await adapter.render(viewModel('92'));
    await flushBridge();
    expect(adapter.getBridgeDiagnostics().stallRecoveryFailures).toBe(0);
  }, 10_000);

  it('reports current operation, growing age, stall and recovery in diagnostics', async () => {
    const adapter = await connectedAdapter({
      ...SHORT_TIMEOUTS,
      stallSettleGraceMs: 80,
    });
    await adapter.render(viewModel('80'));
    await flushBridge();

    sdk.bridge.updateImageRawData.mockReturnValue(neverSettling());
    now += 1_000;
    await adapter.render(viewModel('90'));
    await flushBridge();

    await waitFor(() => adapter.getBridgeDiagnostics().operation.currentOperation === 'speed-image');
    const age1 = adapter.getBridgeDiagnostics().operationAgeMs;
    now += 20;
    const age2 = adapter.getBridgeDiagnostics().operationAgeMs;
    expect(age1).not.toBeNull();
    expect(age2).toBeGreaterThan(age1 as number);

    await waitFor(() => adapter.getBridgeDiagnostics().operation.stalled);
    const stalled = adapter.getBridgeDiagnostics();
    expect(stalled.operation.stalled).toBe(true);
    expect(stalled.lastRecoveryReason).toBe('transport-stall');
    await waitFor(() => adapter.getBridgeDiagnostics().recoveryCount >= 1);
    expect(adapter.getBridgeDiagnostics().recoveryCount).toBeGreaterThanOrEqual(1);
    await waitFor(() => adapter.getBridgeDiagnostics().status === 'CONNECTED');
  });
});
