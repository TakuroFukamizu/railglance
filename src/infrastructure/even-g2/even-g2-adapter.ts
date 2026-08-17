import {
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
import {
  DEFAULT_BRIDGE_READY_TIMEOUT_MS,
  resolveBridgeReadyTimeoutMs,
  waitForEvenAppBridgeWithin,
} from '../even-app/bridge-ready';
import { createSpeedPng } from './speed-png-generator';
import { addRuntimeBreadcrumb, captureRuntimeError } from '../observability/sentry';

export { DEFAULT_BRIDGE_READY_TIMEOUT_MS };

const BRIDGE_TIMEOUT_LOG_PREFIX = '[EvenG2Adapter]';

export interface HybridEvenG2AdapterOptions {
  /**
   * Overrides {@link DEFAULT_BRIDGE_READY_TIMEOUT_MS}.
   *
   * Must be a finite, positive number of milliseconds. Anything else falls
   * back to the default; values beyond the largest delay `setTimeout` can hold
   * are clamped.
   */
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
  private lastStatusMode: HudViewModel['statusMode'] | null = null;
  private latestRequestedSpeedKmh: number | null = null;
  private latestRequestedIsEstimated = false;
  private lastModel: HudViewModel | null = null;

  /** Monotonic generation of lastModel; used for latest-wins coalescing. */
  private renderGeneration = 0;
  private flushedGeneration = 0;
  /** True when a coalesced HUD flush is already queued on bridgeQueue. */
  private hudFlushQueued = false;

  private disconnectWaiters: Array<() => void> = [];

  /**
   * Incremented every time a new native page session is established.
   *
   * `isConnected` is a plain boolean, so it cannot distinguish "still the
   * session I was queued for" from "a different session that happens to be
   * connected now" (ABA). Bridge operations that sit in bridgeQueue capture
   * this at enqueue time and re-check it before touching the page.
   */
  private sessionEpoch = 0;

  private readonly bridgeReadyTimeoutMs: number;

  constructor(
    onRender?: (formattedText: string, model: HudViewModel) => void,
    options: HybridEvenG2AdapterOptions = {}
  ) {
    this.onRenderCallback = onRender;
    this.bridgeReadyTimeoutMs = resolveBridgeReadyTimeoutMs(
      options.bridgeReadyTimeoutMs,
      BRIDGE_TIMEOUT_LOG_PREFIX
    );
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
      addRuntimeBreadcrumb('railglance.bridge', 'Even G2 disconnected', { reason }, 'warning');
      const waiters = this.disconnectWaiters;
      this.disconnectWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  public async connect(): Promise<boolean> {
    try {
      if (!this.bridge) {
        // Bounded: an unbounded handshake parks this reconnect loop forever,
        // with no log and no error. See ../even-app/bridge-ready.
        this.bridge = await waitForEvenAppBridgeWithin(this.bridgeReadyTimeoutMs);
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
          this.markDisconnected('createStartUpPageContainer failed');
          throw new Error(`createStartUpPageContainer failed with code: ${String(result)}`);
        }

        this.lastHeaderContent = '';
        this.lastSegmentContent = '';
        this.lastFooterContent = '';
        this.lastRenderedSpeedKmh = null;
        this.lastRenderedIsEstimated = false;
        this.lastStatusMode = null;
        this.flushedGeneration = 0;
        this.pageReady = true;
        this.isConnected = true;
        this.sessionEpoch += 1;
        addRuntimeBreadcrumb('railglance.bridge', 'Even G2 page initialized');
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
      captureRuntimeError(err, 'even-g2-connect');
      // Always route failures through markDisconnected so any waiter registered
      // by a previous session is released instead of stranding the caller.
      this.markDisconnected('connect() failed');
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
      const completed = await this.flushHudModel(model, generationAtStart);

      if (!completed) {
        if (this.isConnected && this.pageReady) this.queueHudFlush();
        return;
      }

      this.flushedGeneration = generationAtStart;

      // Latest-wins: if render() advanced the generation while we were flushing, schedule again.
      if (this.renderGeneration !== this.flushedGeneration && this.isConnected && this.pageReady) {
        this.queueHudFlush();
      }
    }).catch((error) => {
      console.warn('[EvenG2Adapter] HUD flush failed:', error);
      captureRuntimeError(error, 'even-g2-hud-flush');
    });
  }

  /**
   * Apply one HUD model as a sequence of native calls. Returns false when a
   * newer render generation arrived at a safe await boundary so remaining
   * stale fields must be abandoned.
   */
  private async flushHudModel(model: HudViewModel, generationAtStart: number): Promise<boolean> {
    const texts = this.buildHudTextContents(model);
    const { speedKmh, isEstimated } = this.parseHudSpeed(model);
    const routeStatusCritical =
      texts.headerContent !== this.lastHeaderContent || model.statusMode !== this.lastStatusMode;

    const sendHeader = () => this.pushTextField(1, 'header', texts.headerContent, 'lastHeaderContent');
    const sendFooter = () => this.pushTextField(4, 'footer', texts.footerContent, 'lastFooterContent');
    const sendSegment = () => this.pushTextField(3, 'segment', texts.segmentContent, 'lastSegmentContent');
    const sendSpeed = () => this.pushSpeedImage(speedKmh, isEstimated, false);

    // Route/status-critical frames must not leave an old line/status visible
    // while the speed image of the new frame is transferring.
    const ops = routeStatusCritical
      ? [sendHeader, sendFooter, sendSegment, sendSpeed]
      : [sendSpeed, sendHeader, sendSegment, sendFooter];

    for (const op of ops) {
      if (!this.isFlushGenerationCurrent(generationAtStart)) return false;
      await op();
    }
    if (!this.isFlushGenerationCurrent(generationAtStart)) return false;
    if (
      texts.headerContent === this.lastHeaderContent &&
      texts.footerContent === this.lastFooterContent
    ) {
      this.lastStatusMode = model.statusMode;
    }
    return true;
  }

  private isFlushGenerationCurrent(generationAtStart: number): boolean {
    return this.renderGeneration === generationAtStart && this.isConnected && this.pageReady;
  }

  private buildHudTextContents(model: HudViewModel): {
    headerContent: string;
    segmentContent: string;
    footerContent: string;
  } {
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
    return { headerContent, segmentContent, footerContent };
  }

  private parseHudSpeed(model: HudViewModel): { speedKmh: number | null; isEstimated: boolean } {
    const rawSpeedVal =
      model.speed.displaySpeedKmhText === '--' ? null : parseInt(model.speed.displaySpeedKmhText, 10);
    const speedKmh = isNaN(rawSpeedVal as any) ? null : rawSpeedVal;
    return { speedKmh, isEstimated: model.speed.isEstimated };
  }

  private async pushTextField(
    containerID: number,
    containerName: 'header' | 'segment' | 'footer',
    content: string,
    cacheKey: 'lastHeaderContent' | 'lastSegmentContent' | 'lastFooterContent'
  ): Promise<void> {
    if (!this.bridge || !this.pageReady) return;
    if (content === this[cacheKey]) return;

    try {
      const updated = await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID, containerName, content })
      );
      if (updated === false) {
        console.warn(`[EvenG2Adapter] ${containerName} textContainerUpgrade returned false (will retry)`);
      } else {
        this[cacheKey] = content;
      }
    } catch (error) {
      console.warn(`[EvenG2Adapter] ${containerName} textContainerUpgrade error:`, error);
      captureRuntimeError(error, 'even-g2-text-update', { container: containerName });
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
      } else {
        console.warn('[EvenG2Adapter] Speed image update non-success result:', resultStr);
      }
    } catch (err: any) {
      const errMessage = err?.message || String(err);
      this.lastImageResult = `error: ${errMessage}`;
      console.warn('[EvenG2Adapter] Error in speed image update operation:', errMessage);
      captureRuntimeError(err, 'even-g2-image-update');
      addRuntimeBreadcrumb('railglance.bridge', 'Even G2 image update failed', {}, 'error');
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
        addRuntimeBreadcrumb('railglance.lifecycle', 'Even Hub foreground exit');
      } else if (eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
        addRuntimeBreadcrumb('railglance.lifecycle', 'Even Hub foreground enter');
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
    // Once disconnected, the reconnect loop owns recovery: never resurrect the
    // session from a stale foreground event.
    if (!this.bridge || !this.isConnected) return;
    // Bind this recovery to the session that is live right now. A slow BLE op can
    // hold bridgeQueue long enough for this session to die and the reconnect loop
    // to build a replacement, and createStartUpPageContainer does not go through
    // the queue — so by the time we run, `isConnected` may be true for a session
    // that was never ours.
    const epoch = this.sessionEpoch;
    console.log('[EvenG2Adapter] FOREGROUND_ENTER — rebuilding page containers');

    let rebuiltThisSession = false;
    try {
      await this.enqueueBridgeOperation(async () => {
        // A disconnect — or a whole disconnect/reconnect cycle — may have landed
        // while this rebuild waited in the queue.
        if (!this.isConnected || this.sessionEpoch !== epoch) return;
        const rebuilt = await this.bridge.rebuildPageContainer(
          new RebuildPageContainer({ containerTotalNum: 4, ...this.createPageDefinition() })
        );
        if (!rebuilt) throw new Error('rebuildPageContainer failed');
        if (!this.isConnected || this.sessionEpoch !== epoch) return;
        this.lastHeaderContent = '';
        this.lastSegmentContent = '';
        this.lastFooterContent = '';
        this.lastRenderedSpeedKmh = null;
        this.lastRenderedIsEstimated = false;
        this.lastStatusMode = null;
        this.flushedGeneration = 0;
        this.pageReady = true;
        this.isConnected = true;
        rebuiltThisSession = true;
      });
    } catch (error) {
      console.warn('[EvenG2Adapter] Page recovery failed:', error);
      captureRuntimeError(error, 'even-g2-page-recovery');
      // Only our own session's failure means "no usable page". If a newer session
      // already owns the bridge, tearing it down here would resolve its disconnect
      // waiter and cost a spurious reconnect cycle for a page we never built.
      if (this.sessionEpoch === epoch) {
        // A failed rebuild leaves no usable page: transition to the disconnected
        // state so waitUntilDisconnected() resolves and AppController reconnects.
        this.markDisconnected('page recovery failed');
      }
      return;
    }

    if (!rebuiltThisSession) {
      // Either the session was torn down outright, or it was torn down and a new
      // one took its place; both leave this recovery with no page of its own.
      console.log('[EvenG2Adapter] Skipped page recovery (its session is no longer current)');
      return;
    }

    if (this.lastModel) {
      // Force a fresh flush of the latest HUD after rebuild.
      this.renderGeneration += 1;
      this.queueHudFlush();
      return;
    }

    // Mirrors connect(): the image push is a soft failure and must never drop a
    // page that was rebuilt successfully.
    try {
      await this.queueSpeedImageUpdate(
        this.latestRequestedSpeedKmh,
        this.latestRequestedIsEstimated,
        true
      );
    } catch (imgErr) {
      console.warn('[EvenG2Adapter] Recovery speed PNG update notice:', imgErr);
    }
  }
}

export const MockEvenG2Adapter = HybridEvenG2Adapter;
