import {
  waitForEvenAppBridge,
  ImageContainerProperty,
  ImageRawDataUpdate,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  ImageRawDataUpdateResult,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk';
import { HudViewModel } from '../../domain/models/hud';
import { createSpeedPng } from './speed-png-generator';

/**
 * Upper bound for the SDK bridge handshake.
 *
 * The WebView pushes the bridge once page loading completes, so this only needs
 * to be generous enough to cover a slow start-up. Paired with AppController's
 * backoff (max 10s) it retries roughly every 20s while the bridge is absent.
 */
export const DEFAULT_BRIDGE_READY_TIMEOUT_MS = 10_000;

export interface HybridEvenG2AdapterOptions {
  /** Overrides {@link DEFAULT_BRIDGE_READY_TIMEOUT_MS}. */
  bridgeReadyTimeoutMs?: number;
}

export interface EvenG2Adapter {
  connect(): Promise<boolean>;
  render(model: HudViewModel): Promise<void>;
  clear(): Promise<void>;
  getLastImageResult(): string;
  /** True while the native page is connected and accepting HUD updates. */
  isBridgeConnected?(): boolean;
  /**
   * Resolves when the bridge leaves the connected state (OS exit / clear).
   * Optional — AppController uses it for auto-reconnect when present.
   */
  waitUntilDisconnected?(): Promise<void>;
}

/**
 * Hybrid Even G2 adapter.
 *
 * Design constraints (Even Hub SDK):
 * - Native BLE ops must stay strictly serial (single bridgeQueue).
 * - Never Promise.race-timeout a native image transfer and start another one
 *   while the first is still in flight (no cancel API).
 *
 * Freeze-resistance:
 * - render() is non-blocking for callers (web preview updates immediately).
 * - Bridge HUD updates are latest-wins coalesced so a slow BLE transfer never
 *   queues a backlog of stale frames.
 * - textContainerUpgrade failures are soft (logged, retried next flush).
 */
export class HybridEvenG2Adapter implements EvenG2Adapter {
  private onRenderCallback?: (formattedText: string, model: HudViewModel) => void;
  private bridge: any = null;
  private isConnected = false;
  private pageReady = false;
  private lastImageResult = 'none';
  private unsubscribeHubEvents: (() => void) | null = null;

  private bridgeQueue: Promise<void> = Promise.resolve();

  private lastHeaderContent = '';
  private lastSegmentContent = '';
  private lastFooterContent = '';

  private lastRenderedSpeedKmh: number | null = null;
  private lastRenderedIsEstimated = false;
  private lastImageUpdateTimeMs = 0;
  private readonly SPEED_IMAGE_MIN_INTERVAL_MS = 1000;
  private latestRequestedSpeedKmh: number | null = null;
  private latestRequestedIsEstimated = false;
  private lastModel: HudViewModel | null = null;

  /** Monotonic generation of lastModel; used for latest-wins coalescing. */
  private renderGeneration = 0;
  private flushedGeneration = 0;
  /** True when a coalesced HUD flush is already queued on bridgeQueue. */
  private hudFlushQueued = false;

  private disconnectWaiters: Array<() => void> = [];

  private readonly bridgeReadyTimeoutMs: number;

  constructor(
    onRender?: (formattedText: string, model: HudViewModel) => void,
    options: HybridEvenG2AdapterOptions = {}
  ) {
    this.onRenderCallback = onRender;
    this.bridgeReadyTimeoutMs = options.bridgeReadyTimeoutMs ?? DEFAULT_BRIDGE_READY_TIMEOUT_MS;
  }

  public getLastImageResult(): string {
    return this.lastImageResult;
  }

  public isBridgeConnected(): boolean {
    return this.isConnected && this.pageReady;
  }

  /**
   * Resolves when the bridge leaves the connected state (exit / clear / failed recover).
   * Used by AppController to drive auto-reconnect.
   */
  public waitUntilDisconnected(): Promise<void> {
    if (!this.isConnected) return Promise.resolve();
    return new Promise((resolve) => {
      this.disconnectWaiters.push(resolve);
    });
  }

  /**
   * Enqueues all BLE bridge operations into a single strict sequential execution queue.
   * Previous failures never poison the queue.
   */
  private enqueueBridgeOperation(operation: () => Promise<void>): Promise<void> {
    const next = this.bridgeQueue
      .catch((error) => {
        console.warn('[EvenG2Adapter] Previous bridge operation failed:', error);
      })
      .then(operation);

    // Keep the chain void-typed even when operation rejects.
    this.bridgeQueue = next.catch(() => {});
    return next;
  }

  private markDisconnected(reason: string): void {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.pageReady = false;
    if (wasConnected) {
      console.warn(`[EvenG2Adapter] Disconnected: ${reason}`);
      const waiters = this.disconnectWaiters;
      this.disconnectWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * Bounded wrapper around the SDK handshake.
   *
   * `waitForEvenAppBridge()` resolves on an `evenAppBridgeReady` event and the SDK
   * exposes no timeout, so a bridge that never initializes parks connect() forever:
   * AppController's reconnect loop awaits it and never iterates again, leaving no
   * log and no error. Bounding it turns that silent stall into a normal connect
   * failure that backoff retries — and that error reporting can observe.
   */
  private async waitForBridgeReady(): Promise<any> {
    const pending = waitForEvenAppBridge();
    // Promise.race already handles a late settle, but keep this explicit so the
    // abandoned SDK promise can never surface as an unhandled rejection.
    void pending.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`waitForEvenAppBridge() timed out after ${this.bridgeReadyTimeoutMs}ms`)
          ),
        this.bridgeReadyTimeoutMs
      );
    });

    try {
      return await Promise.race([pending, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  public async connect(): Promise<boolean> {
    try {
      if (!this.bridge) {
        this.bridge = await this.waitForBridgeReady();
        console.log('[EvenG2Adapter] waitForEvenAppBridge() resolved!');
      }

      if (this.bridge) {
        const definition = this.createPageDefinition();

        const result = await this.bridge.createStartUpPageContainer(
          new CreateStartUpPageContainer({
            containerTotalNum: 4,
            ...definition,
          })
        );

        console.log('[EvenG2Adapter] createStartUpPageContainer result:', {
          result,
          type: typeof result,
        });

        const isSuccess = result === StartUpPageCreateResult.success;

        if (!isSuccess) {
          this.isConnected = false;
          this.pageReady = false;
          throw new Error(`createStartUpPageContainer failed with code: ${String(result)}`);
        }

        this.lastHeaderContent = '';
        this.lastSegmentContent = '';
        this.lastFooterContent = '';
        this.lastRenderedSpeedKmh = null;
        this.lastRenderedIsEstimated = false;
        this.lastImageUpdateTimeMs = 0;
        this.flushedGeneration = 0;
        this.pageReady = true;
        this.isConnected = true;
        this.subscribeToLifecycleEvents();

        // Initial image after page is ready (must stay on bridgeQueue). Failures must not block text/GPS.
        try {
          await this.queueSpeedImageUpdate(null, false, true);
        } catch (imgErr) {
          console.warn(
            '[EvenG2Adapter] Initial speed PNG update notice (continuing TextContainer & GPS updates):',
            imgErr
          );
        }
      }
    } catch (err) {
      console.log('[EvenG2Adapter] Bridge connection notice:', err);
      this.isConnected = false;
      this.pageReady = false;
    }
    return this.isConnected;
  }

  /**
   * Non-blocking for the caller: web preview updates immediately, Glass flush is
   * scheduled as a coalesced latest-wins bridge operation.
   */
  public async render(model: HudViewModel): Promise<void> {
    this.lastModel = model;
    this.renderGeneration += 1;

    const rawSpeedVal =
      model.speed.displaySpeedKmhText === '--' ? null : parseInt(model.speed.displaySpeedKmhText, 10);
    const speedKmh = isNaN(rawSpeedVal as any) ? null : rawSpeedVal;
    const isEstimated = model.speed.isEstimated;
    this.latestRequestedSpeedKmh = speedKmh;
    this.latestRequestedIsEstimated = isEstimated;

    // Web / console preview must never wait on BLE.
    const formattedText = model.rawFormattedText;
    console.log('[EvenG2 HUD Output]:\n' + formattedText);
    if (this.onRenderCallback) {
      this.onRenderCallback(formattedText, model);
    }

    if (this.bridge && this.isConnected && this.pageReady) {
      this.queueHudFlush();
    }
  }

  /**
   * Schedule at most one pending HUD flush on the bridge queue. When it runs it
   * always applies the latest model; if newer renders arrived mid-flight, it
   * reschedules once.
   */
  private queueHudFlush(): void {
    if (this.hudFlushQueued) return;
    if (!this.bridge || !this.isConnected || !this.pageReady) return;

    this.hudFlushQueued = true;
    void this.enqueueBridgeOperation(async () => {
      this.hudFlushQueued = false;

      if (!this.bridge || !this.isConnected || !this.pageReady || !this.lastModel) {
        return;
      }

      const generationAtStart = this.renderGeneration;
      const model = this.lastModel;

      await this.pushTextContainers(model);

      const rawSpeedVal =
        model.speed.displaySpeedKmhText === '--' ? null : parseInt(model.speed.displaySpeedKmhText, 10);
      const speedKmh = isNaN(rawSpeedVal as any) ? null : rawSpeedVal;
      const isEstimated = model.speed.isEstimated;
      const now = Date.now();
      const isSpeedChanged =
        speedKmh !== this.lastRenderedSpeedKmh || isEstimated !== this.lastRenderedIsEstimated;
      const isTimeElapsed = now - this.lastImageUpdateTimeMs >= this.SPEED_IMAGE_MIN_INTERVAL_MS;

      if (isSpeedChanged && isTimeElapsed) {
        await this.pushSpeedImage(speedKmh, isEstimated, false);
      }

      this.flushedGeneration = generationAtStart;

      // Latest-wins: if render() advanced the generation while we were flushing, schedule again.
      if (this.renderGeneration !== this.flushedGeneration && this.isConnected && this.pageReady) {
        this.queueHudFlush();
      }
    }).catch((error) => {
      console.warn('[EvenG2Adapter] HUD flush failed:', error);
    });
  }

  private async pushTextContainers(model: HudViewModel): Promise<void> {
    if (!this.bridge || !this.pageReady) return;

    const headerContent = `${model.header.lineName}               ${model.header.serviceOrDirection}`;

    let progressBarStr = '━━━━━━━━━━━━';
    if (model.segment.progressRatio !== null) {
      const totalChars = 12;
      const dotIdx = Math.max(
        0,
        Math.min(totalChars - 1, Math.round(model.segment.progressRatio * (totalChars - 1)))
      );
      const leftBar = '━'.repeat(dotIdx);
      const rightBar = '━'.repeat(totalChars - 1 - dotIdx);
      progressBarStr = `${leftBar}●${rightBar}`;
    }
    const segmentContent = `${model.segment.previousStationName} ${progressBarStr} ${model.segment.nextStationName}`;
    const footerContent = `${model.segment.distanceToNextText}               ${model.footer.statusRight}`;

    if (headerContent !== this.lastHeaderContent) {
      try {
        const updated = await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: 1, containerName: 'header', content: headerContent })
        );
        if (updated === false) {
          console.warn('[EvenG2Adapter] header textContainerUpgrade returned false (will retry)');
        } else {
          this.lastHeaderContent = headerContent;
        }
      } catch (error) {
        console.warn('[EvenG2Adapter] header textContainerUpgrade error:', error);
      }
    }

    if (segmentContent !== this.lastSegmentContent) {
      try {
        const updated = await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: 3, containerName: 'segment', content: segmentContent })
        );
        if (updated === false) {
          console.warn('[EvenG2Adapter] segment textContainerUpgrade returned false (will retry)');
        } else {
          this.lastSegmentContent = segmentContent;
        }
      } catch (error) {
        console.warn('[EvenG2Adapter] segment textContainerUpgrade error:', error);
      }
    }

    if (footerContent !== this.lastFooterContent) {
      try {
        const updated = await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: 4, containerName: 'footer', content: footerContent })
        );
        if (updated === false) {
          console.warn('[EvenG2Adapter] footer textContainerUpgrade returned false (will retry)');
        } else {
          this.lastFooterContent = footerContent;
        }
      } catch (error) {
        console.warn('[EvenG2Adapter] footer textContainerUpgrade error:', error);
      }
    }
  }

  /**
   * Native image transfer. Must fully await the SDK promise (no local cancel).
   * Runs either as part of a coalesced flush or as the initial connect image.
   */
  private async pushSpeedImage(
    speedKmh: number | null,
    isEstimated: boolean,
    force: boolean
  ): Promise<void> {
    if (!this.bridge || !this.isConnected || !this.pageReady) return;

    if (!force && speedKmh === this.lastRenderedSpeedKmh && isEstimated === this.lastRenderedIsEstimated) {
      return;
    }

    try {
      const pngUint8Array = await createSpeedPng(speedKmh, isEstimated);

      const updateModel = new ImageRawDataUpdate({
        containerID: 2,
        containerName: 'speed_img',
        imageData: pngUint8Array,
      });

      const startedAt = Date.now();
      const result = await this.bridge.updateImageRawData(updateModel);
      const elapsedMs = Date.now() - startedAt;
      const resultStr = String(result);
      this.lastImageResult = resultStr;

      if (elapsedMs >= 3000) {
        console.warn(`[EvenG2Adapter] Slow image transfer: ${elapsedMs}ms result=${resultStr}`);
      } else {
        console.log('[Speed PNG Update Result]:', resultStr, `(${elapsedMs}ms)`);
      }

      if (ImageRawDataUpdateResult.isSuccess(result)) {
        this.lastRenderedSpeedKmh = speedKmh;
        this.lastRenderedIsEstimated = isEstimated;
        this.lastImageUpdateTimeMs = Date.now();
      } else {
        console.warn('[EvenG2Adapter] Speed image update non-success result:', resultStr);
      }
    } catch (err: any) {
      const errMessage = err?.message || String(err);
      this.lastImageResult = `error: ${errMessage}`;
      console.warn('[EvenG2Adapter] Error in speed image update operation:', errMessage);
    }
  }

  /** Queue-wrapped initial / recovery image push. */
  private queueSpeedImageUpdate(
    speedKmh: number | null,
    isEstimated: boolean,
    force = false
  ): Promise<void> {
    return this.enqueueBridgeOperation(async () => {
      await this.pushSpeedImage(speedKmh, isEstimated, force);
    });
  }

  public async clear(): Promise<void> {
    await this.enqueueBridgeOperation(async () => {
      if (this.bridge && typeof this.bridge.shutDownPageContainer === 'function') {
        const closed = await this.bridge.shutDownPageContainer(0);
        if (!closed) throw new Error('shutDownPageContainer failed');
      }
    }).catch((err) => {
      console.warn('[EvenG2Adapter] Error shutting down page container:', err);
    });
    this.unsubscribeHubEvents?.();
    this.unsubscribeHubEvents = null;
    this.markDisconnected('clear()');
    console.log('[EvenG2 HUD Output]: Cleared.');
  }

  private createPageDefinition(): {
    textObject: TextContainerProperty[];
    imageObject: ImageContainerProperty[];
  } {
    const headerContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 44,
      borderWidth: 0,
      paddingLength: 0,
      containerID: 1,
      containerName: 'header',
      content: '路線特定中',
      isEventCapture: 1,
      zOrderIndex: 1,
    });
    const speedImageContainer = new ImageContainerProperty({
      xPosition: 188,
      yPosition: 70,
      width: 200,
      height: 100,
      containerID: 2,
      containerName: 'speed_img',
      zOrderIndex: 2,
    });
    const segmentContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 196,
      width: 576,
      height: 48,
      borderWidth: 0,
      paddingLength: 0,
      containerID: 3,
      containerName: 'segment',
      content: '前駅不明 ━━━━━●━━━━━ 次駅推定中',
      isEventCapture: 0,
      zOrderIndex: 3,
    });
    const footerContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 248,
      width: 576,
      height: 40,
      borderWidth: 0,
      paddingLength: 0,
      containerID: 4,
      containerName: 'footer',
      content: '次まで --                    GPS',
      isEventCapture: 0,
      zOrderIndex: 4,
    });
    return {
      textObject: [headerContainer, segmentContainer, footerContainer],
      imageObject: [speedImageContainer],
    };
  }

  private subscribeToLifecycleEvents(): void {
    if (this.unsubscribeHubEvents || !this.bridge) return;
    this.unsubscribeHubEvents = this.bridge.onEvenHubEvent((event: any) => {
      const eventType = event.sysEvent?.eventType ?? event.textEvent?.eventType;
      if (eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
        // Pause outbound updates while backgrounded; keep isConnected so ENTER can recover.
        this.pageReady = false;
        console.log('[EvenG2Adapter] FOREGROUND_EXIT — pausing HUD updates');
      } else if (eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
        void this.recoverPage();
      } else if (
        eventType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
        eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT
      ) {
        this.markDisconnected(`OS exit event ${String(eventType)}`);
      }
    });
  }

  private async recoverPage(): Promise<void> {
    if (!this.bridge) return;
    console.log('[EvenG2Adapter] FOREGROUND_ENTER — rebuilding page containers');
    try {
      await this.enqueueBridgeOperation(async () => {
        const rebuilt = await this.bridge.rebuildPageContainer(
          new RebuildPageContainer({ containerTotalNum: 4, ...this.createPageDefinition() })
        );
        if (!rebuilt) throw new Error('rebuildPageContainer failed');
        this.lastHeaderContent = '';
        this.lastSegmentContent = '';
        this.lastFooterContent = '';
        this.lastRenderedSpeedKmh = null;
        this.lastRenderedIsEstimated = false;
        this.flushedGeneration = 0;
        this.pageReady = true;
        this.isConnected = true;
      });

      if (this.lastModel) {
        // Force a fresh flush of the latest HUD after rebuild.
        this.renderGeneration += 1;
        this.queueHudFlush();
      } else {
        await this.queueSpeedImageUpdate(
          this.latestRequestedSpeedKmh,
          this.latestRequestedIsEstimated,
          true
        );
      }
    } catch (error) {
      this.pageReady = false;
      console.warn('[EvenG2Adapter] Page recovery failed:', error);
    }
  }
}

export const MockEvenG2Adapter = HybridEvenG2Adapter;
