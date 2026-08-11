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

describe('HybridEvenG2Adapter', () => {
  let hubEvent: ((event: any) => void) | undefined;
  let now = 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
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

  it('creates a valid all-zOrder page and soft-retries text updates that return false', async () => {
    const adapter = new HybridEvenG2Adapter();
    expect(await adapter.connect()).toBe(true);
    const page = sdk.bridge.createStartUpPageContainer.mock.calls[0][0];
    const containers = [...page.textObject, ...page.imageObject];
    expect(new Set(containers.map((item: any) => item.zOrderIndex)).size).toBe(4);
    expect(containers.filter((item: any) => item.isEventCapture === 1)).toHaveLength(1);

    sdk.bridge.textContainerUpgrade.mockResolvedValueOnce(false);
    await adapter.render(viewModel('80'));
    await flushBridge();

    // Soft failure: no throw, header not committed, next flush retries.
    await adapter.render(viewModel('80'));
    await flushBridge();

    const headerCalls = sdk.bridge.textContainerUpgrade.mock.calls.filter(
      ([update]) => update.containerName === 'header'
    );
    expect(headerCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('never overlaps native image transfers even when render calls overlap', async () => {
    let active = 0;
    let maxActive = 0;
    sdk.bridge.updateImageRawData.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return 'success';
    });
    const adapter = new HybridEvenG2Adapter();
    await adapter.connect();

    now += 1000;
    const first = adapter.render(viewModel('80'));
    now += 1000;
    const second = adapter.render(viewModel('81'));
    await Promise.all([first, second]);
    await flushBridge();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxActive).toBe(1);
  });

  it('coalesces rapid renders so intermediate frames are skipped', async () => {
    let resolveImage!: (value: string) => void;
    let imageCalls = 0;
    sdk.bridge.updateImageRawData.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          imageCalls++;
          // First call (connect initial) resolves immediately; subsequent hang until released.
          if (imageCalls === 1) {
            resolve('success');
          } else {
            resolveImage = resolve;
          }
        })
    );

    const adapter = new HybridEvenG2Adapter();
    await adapter.connect();
    expect(imageCalls).toBe(1);

    now += 1000;
    // Burst of speed updates while first transfer is in flight / queued.
    await adapter.render(viewModel('10'));
    await adapter.render(viewModel('20'));
    await adapter.render(viewModel('30'));
    await flushBridge();

    // Only one non-initial image transfer should be in flight/queued at a time (latest-wins).
    expect(imageCalls).toBe(2);

    resolveImage!('success');
    await flushBridge();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // After the slow transfer, at most one more flush for the latest model (30).
    // Intermediate 10/20 must not each produce their own image call.
    expect(imageCalls).toBeLessThanOrEqual(3);

    const headerContents = sdk.bridge.textContainerUpgrade.mock.calls
      .filter(([u]) => u.containerName === 'header')
      .map(([u]) => u.content as string);
    // Latest line content should have been applied (same line name, so maybe once).
    expect(headerContents.some((c) => c.includes('小田急線'))).toBe(true);
  });

  it('rebuilds after foreground re-entry and resends the latest HUD', async () => {
    const adapter = new HybridEvenG2Adapter();
    await adapter.connect();
    now += 1000;
    await adapter.render(viewModel('90'));
    await flushBridge();

    hubEvent?.({ sysEvent: { eventType: 5 } });
    hubEvent?.({ sysEvent: { eventType: 4 } });
    await flushBridge();
    await flushBridge();

    expect(sdk.bridge.rebuildPageContainer).toHaveBeenCalledOnce();
    expect(sdk.bridge.textContainerUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: 'header', content: expect.stringContaining('小田急線') })
    );
  });

  it('waits for an uncancellable native image transfer before shutting down', async () => {
    const adapter = new HybridEvenG2Adapter();
    await adapter.connect();

    let resolveImage!: (value: string) => void;
    sdk.bridge.updateImageRawData.mockImplementation(
      () => new Promise<string>((resolve) => { resolveImage = resolve; })
    );

    now += 1000;
    await adapter.render(viewModel('100'));
    await flushBridge();
    expect(resolveImage).toBeTypeOf('function');

    const clearing = adapter.clear();
    await flushBridge();
    expect(sdk.bridge.shutDownPageContainer).not.toHaveBeenCalled();

    resolveImage('success');
    await clearing;
    expect(sdk.bridge.shutDownPageContainer).toHaveBeenCalledOnce();
  });

  it('notifies waitUntilDisconnected on system exit', async () => {
    const adapter = new HybridEvenG2Adapter();
    await adapter.connect();
    const disconnected = adapter.waitUntilDisconnected();
    hubEvent?.({ sysEvent: { eventType: 7 } });
    await expect(disconnected).resolves.toBeUndefined();
    expect(adapter.isBridgeConnected()).toBe(false);
  });
});
