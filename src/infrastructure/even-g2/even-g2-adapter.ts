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
  resolvePositiveTimeoutMs,
  waitForEvenAppBridgeWithin,
} from '../even-app/bridge-ready';
import { createSpeedPng } from './speed-png-generator';
import { addRuntimeBreadcrumb, captureRuntimeError } from '../observability/sentry';
import type { TelemetryIdentity } from '../telemetry/types';
import {
  createBridgeOperationTelemetryEvent,
  createStateTransitionTelemetryEvent,
} from '../telemetry/types';
import type { TelemetrySink } from '../telemetry/sinks';
import {
  type BridgeDiagnosticsSnapshot,
  type BridgeOperationKind,
  type BridgeOperationState,
  type BridgeRecoveryReason,
  type BridgeTransportStatus,
  DEFAULT_IMAGE_OPERATION_TIMEOUT_MS,
  DEFAULT_IMAGE_SLOW_WARN_MS,
  DEFAULT_PAGE_OPERATION_TIMEOUT_MS,
  DEFAULT_STALL_SETTLE_GRACE_MS,
  DEFAULT_TEXT_OPERATION_TIMEOUT_MS,
  DEFAULT_TEXT_SLOW_WARN_MS,
  emptyBridgeOperationState,
  RECOVERY_HEALTH_RESET_MS,
  STALL_RECOVERY_BACKOFF_MS,
} from './bridge-operation';

export { DEFAULT_BRIDGE_READY_TIMEOUT_MS };
export type { BridgeDiagnosticsSnapshot };

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
  textOperationTimeoutMs?: number;
  imageOperationTimeoutMs?: number;
  pageOperationTimeoutMs?: number;
  textSlowWarnMs?: number;
  imageSlowWarnMs?: number;
  stallSettleGraceMs?: number;
  telemetry?: { sink: TelemetrySink; identity: TelemetryIdentity };
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
  getBridgeDiagnostics?(): BridgeDiagnosticsSnapshot;
}

type NativeOperationOutcome<T> =
  | { status: 'completed'; value: T }
  | { status: 'stale' }
  | { status: 'stalled' };

type BridgeOperationTelemetryPayload = {
  operation: BridgeOperationKind;
  sequence: number;
  sessionEpoch: number;
  startedAtMs: number;
  completedAtMs?: number;
  elapsedMs?: number;
  result?: string;
  stalled?: boolean;
  slow?: boolean;
  error?: string;
};

/**
 * Hybrid Even G2 adapter.
 *
 * Design constraints (Even Hub SDK):
 * - Native BLE ops must stay strictly serial (single bridgeQueue).
 * - Never Promise.race-timeout a native image transfer and start another
 *   *normal* BLE op while the first is still in flight (no cancel API).
 *   A watchdog timeout means the transport session is broken: the wrapper
 *   settles so callers can recover, but the SDK promise is never abandoned
 *   and the queue is amputated so the next HUD op cannot start on it.
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
  private lastImageCompletedAtMs: number | null = null;
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
  /** A flush sits on bridgeQueue, not started yet. */
  private hudFlushScheduled = false;
  /** The flush body is running. */
  private hudFlushInFlight = false;
  /** lastModel is newer than flushedGeneration. */
  private hudDirty = false;
  private scheduledGeneration = 0;
  private inFlightGeneration = 0;

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

  /**
   * Stall is tracked per session epoch, not as a plain boolean.
   *
   * Recovery rebuilds run under epoch N+1. A boolean "already stalled" flag
   * set by the original stall would swallow the rebuild's own stall and leave
   * that newer session wedged with no recovery.
   */
  private stalledEpoch: number | null = null;
  private transportStatus: BridgeTransportStatus = 'DISCONNECTED';
  private operationState: BridgeOperationState = emptyBridgeOperationState();
  private isRecoveringTransport = false;
  private recoveryCount = 0;
  private stallRecoveryFailures = 0;
  private lastRecoveryReason: string | null = null;
  private lastRecoveryAtMs: number | null = null;
  private healthyStreakStartedAtMs: number | null = null;

  private readonly bridgeReadyTimeoutMs: number;
  private readonly textOperationTimeoutMs: number;
  private readonly imageOperationTimeoutMs: number;
  private readonly pageOperationTimeoutMs: number;
  private readonly textSlowWarnMs: number;
  private readonly imageSlowWarnMs: number;
  private readonly stallSettleGraceMs: number;
  private readonly telemetry?: { sink: TelemetrySink; identity: TelemetryIdentity };

  constructor(
    onRender?: (formattedText: string, model: HudViewModel) => void,
    options: HybridEvenG2AdapterOptions = {}
  ) {
    this.onRenderCallback = onRender;
    this.bridgeReadyTimeoutMs = resolveBridgeReadyTimeoutMs(
      options.bridgeReadyTimeoutMs,
      BRIDGE_TIMEOUT_LOG_PREFIX
    );
    this.textOperationTimeoutMs = resolvePositiveTimeoutMs(
      options.textOperationTimeoutMs,
      DEFAULT_TEXT_OPERATION_TIMEOUT_MS,
      'textOperationTimeoutMs',
      BRIDGE_TIMEOUT_LOG_PREFIX
    );
    this.imageOperationTimeoutMs = resolvePositiveTimeoutMs(
      options.imageOperationTimeoutMs,
      DEFAULT_IMAGE_OPERATION_TIMEOUT_MS,
      'imageOperationTimeoutMs',
      BRIDGE_TIMEOUT_LOG_PREFIX
    );
    this.pageOperationTimeoutMs = resolvePositiveTimeoutMs(
      options.pageOperationTimeoutMs,
      DEFAULT_PAGE_OPERATION_TIMEOUT_MS,
      'pageOperationTimeoutMs',
      BRIDGE_TIMEOUT_LOG_PREFIX
    );
    this.textSlowWarnMs = resolvePositiveTimeoutMs(
      options.textSlowWarnMs,
      DEFAULT_TEXT_SLOW_WARN_MS,
      'textSlowWarnMs',
      BRIDGE_TIMEOUT_LOG_PREFIX
    );
    this.imageSlowWarnMs = resolvePositiveTimeoutMs(
      options.imageSlowWarnMs,
      DEFAULT_IMAGE_SLOW_WARN_MS,
      'imageSlowWarnMs',
      BRIDGE_TIMEOUT_LOG_PREFIX
    );
    this.stallSettleGraceMs = resolvePositiveTimeoutMs(
      options.stallSettleGraceMs,
      DEFAULT_STALL_SETTLE_GRACE_MS,
      'stallSettleGraceMs',
      BRIDGE_TIMEOUT_LOG_PREFIX
    );
    this.telemetry = options.telemetry;
  }

  public getLastImageResult(): string {
    return this.lastImageResult;
  }

  public isBridgeConnected(): boolean {
    return this.isConnected && this.pageReady;
  }

  public getBridgeDiagnostics(): BridgeDiagnosticsSnapshot {
    const currentStartedAtMs = this.operationState.currentStartedAtMs;
    return {
      status: this.transportStatus,
      pageReady: this.pageReady,
      sessionEpoch: this.sessionEpoch,
      operation: { ...this.operationState },
      operationAgeMs: currentStartedAtMs === null ? null : Date.now() - currentStartedAtMs,
      lastImageResult: this.lastImageResult,
      lastImageCompletedAtMs: this.lastImageCompletedAtMs,
      renderGeneration: this.renderGeneration,
      flushedGeneration: this.flushedGeneration,
      hudFlushScheduled: this.hudFlushScheduled,
      hudFlushInFlight: this.hudFlushInFlight,
      hudDirty: this.hudDirty,
      recoveryCount: this.recoveryCount,
      stallRecoveryFailures: this.stallRecoveryFailures,
      lastRecoveryReason: this.lastRecoveryReason,
      lastRecoveryAtMs: this.lastRecoveryAtMs,
    };
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
   *
   * `epoch` is captured at enqueue time (default: the live session). After a
   * stall amputates the queue, operations already chained behind the hung
   * promise still exist on the old chain — they must self-skip when they
   * finally run, or they would emit BLE traffic for a dead session.
   */
  private enqueueBridgeOperation(
    operation: () => Promise<void>,
    epoch: number = this.sessionEpoch
  ): Promise<void> {
    const next = this.bridgeQueue
      .catch((error) => {
        console.warn('[EvenG2Adapter] Previous bridge operation failed:', error);
      })
      .then(async () => {
        if (this.sessionEpoch !== epoch) return;
        await operation();
      });

    // Keep the chain void-typed even when operation rejects.
    this.bridgeQueue = next.catch(() => {});
    return next;
  }

  private markDisconnected(reason: string): void {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.pageReady = false;
    this.transportStatus = 'DISCONNECTED';
    this.healthyStreakStartedAtMs = null;
    // An unsettled native promise may still exist, but it is no longer
    // attributable to any live session. The epoch-guarded late continuation
    // still reports it when/if it settles.
    this.operationState.currentOperation = null;
    this.operationState.currentStartedAtMs = null;
    this.operationState.stalled = false;
    this.stalledEpoch = null;
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
        const epoch = this.sessionEpoch;

        const outcome = await this.runNativeOperation('page-create', epoch, () =>
          this.bridge.createStartUpPageContainer(
            new CreateStartUpPageContainer({
              containerTotalNum: 4,
              ...definition,
            })
          )
        );

        if (outcome.status !== 'completed') {
          // A hung createStartUpPageContainer must not park AppController's
          // reconnect loop. The wrapper settled; treat this as a normal
          // connect failure so backoff can retry.
          throw new Error(
            outcome.status === 'stalled'
              ? 'createStartUpPageContainer stalled'
              : 'createStartUpPageContainer became stale'
          );
        }

        const result = outcome.value;
        console.log('[EvenG2Adapter] createStartUpPageContainer result:', {
          result,
          type: typeof result,
        });

        const isSuccess = result === StartUpPageCreateResult.success;

        if (!isSuccess) {
          this.markDisconnected('createStartUpPageContainer failed');
          throw new Error(`createStartUpPageContainer failed with code: ${String(result)}`);
        }

        this.resetHudCaches();
        this.flushedGeneration = 0;
        this.hudFlushScheduled = false;
        this.hudFlushInFlight = false;
        this.hudDirty = false;
        this.operationState.stalled = false;
        this.stalledEpoch = null;
        this.pageReady = true;
        this.isConnected = true;
        this.transportStatus = 'CONNECTED';
        this.sessionEpoch += 1;
        addRuntimeBreadcrumb('railglance.bridge', 'Even G2 page initialized');
        this.emitBridgeLifecycle('bridge-page-ready', {
          sessionEpoch: this.sessionEpoch,
          reason: 'connect',
        });
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
    this.hudDirty = true;

    const rawSpeedVal =
      model.speed.displaySpeedKmhText === '--' ? null : parseInt(model.speed.displaySpeedKmhText, 10);
    const speedKmh = isNaN(rawSpeedVal as any) ? null : rawSpeedVal;
    const isEstimated = model.speed.isEstimated;
    this.latestRequestedSpeedKmh = speedKmh;
    this.latestRequestedIsEstimated = isEstimated;

    // Web / console preview must never wait on BLE — including when the glass
    // transport is stalled. GPS / speed / route matching keep moving.
    const formattedText = model.rawFormattedText;
    console.log('[EvenG2 HUD Output]:\n' + formattedText);
    if (this.onRenderCallback) {
      this.onRenderCallback(formattedText, model);
    }

    if (this.bridge && this.isConnected && this.pageReady && !this.operationState.stalled) {
      this.scheduleHudFlush();
    }
  }

  /**
   * Schedule at most one pending HUD flush on the bridge queue. When it runs it
   * always applies the latest model; if newer renders arrived mid-flight, it
   * reschedules once.
   *
   * Invariant: at most 1 in-flight + at most 1 scheduled flush, no matter how
   * many renders arrive (including during a stall). The dirty flag records that
   * another flush is owed; it does not enqueue a new BLE op.
   */
  private scheduleHudFlush(): void {
    if (this.hudFlushScheduled || this.hudFlushInFlight) return;
    if (!this.bridge || !this.isConnected || !this.pageReady || this.operationState.stalled) return;

    this.hudFlushScheduled = true;
    this.scheduledGeneration = this.renderGeneration;
    const epoch = this.sessionEpoch;
    void this.enqueueBridgeOperation(async () => {
      this.hudFlushScheduled = false;
      this.hudFlushInFlight = true;
      this.inFlightGeneration = Math.max(this.scheduledGeneration, this.renderGeneration);
      this.hudDirty = false;
      try {
        if (
          !this.bridge ||
          !this.isConnected ||
          !this.pageReady ||
          this.operationState.stalled ||
          !this.lastModel ||
          this.sessionEpoch !== epoch
        ) {
          return;
        }

        const model = this.lastModel;

        await this.pushTextContainers(model);

        if (
          !this.pageReady ||
          this.operationState.stalled ||
          this.sessionEpoch !== epoch
        ) {
          return;
        }

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

        if (
          !this.pageReady ||
          this.operationState.stalled ||
          this.sessionEpoch !== epoch
        ) {
          return;
        }

        this.flushedGeneration = this.inFlightGeneration;
        this.noteHealthyFlush();
      } finally {
        this.hudFlushInFlight = false;
      }

      // Keep this tail synchronous: an await here would open a gap where
      // render() can set hudDirty and see hudFlushInFlight still true, then
      // the check below would miss it and drop the frame.
      if (
        this.hudDirty &&
        this.isConnected &&
        this.pageReady &&
        !this.operationState.stalled
      ) {
        this.scheduleHudFlush();
      }
    }, epoch).catch((error) => {
      console.warn('[EvenG2Adapter] HUD flush failed:', error);
      captureRuntimeError(error, 'even-g2-hud-flush');
    });
  }

  private async pushTextContainers(model: HudViewModel): Promise<void> {
    if (!this.bridge || !this.pageReady || this.operationState.stalled) return;

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
      if (!this.pageReady || this.operationState.stalled) return;
      try {
        const outcome = await this.runNativeOperation('text-header', this.sessionEpoch, () =>
          this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: 1, containerName: 'header', content: headerContent })
          )
        );
        if (outcome.status !== 'completed') return;
        if (outcome.value === false) {
          console.warn('[EvenG2Adapter] header textContainerUpgrade returned false (will retry)');
        } else {
          this.lastHeaderContent = headerContent;
        }
      } catch (error) {
        console.warn('[EvenG2Adapter] header textContainerUpgrade error:', error);
        captureRuntimeError(error, 'even-g2-text-update', { container: 'header' });
      }
    }

    if (segmentContent !== this.lastSegmentContent) {
      if (!this.pageReady || this.operationState.stalled) return;
      try {
        const outcome = await this.runNativeOperation('text-segment', this.sessionEpoch, () =>
          this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: 3, containerName: 'segment', content: segmentContent })
          )
        );
        if (outcome.status !== 'completed') return;
        if (outcome.value === false) {
          console.warn('[EvenG2Adapter] segment textContainerUpgrade returned false (will retry)');
        } else {
          this.lastSegmentContent = segmentContent;
        }
      } catch (error) {
        console.warn('[EvenG2Adapter] segment textContainerUpgrade error:', error);
        captureRuntimeError(error, 'even-g2-text-update', { container: 'segment' });
      }
    }

    if (footerContent !== this.lastFooterContent) {
      if (!this.pageReady || this.operationState.stalled) return;
      try {
        const outcome = await this.runNativeOperation('text-footer', this.sessionEpoch, () =>
          this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: 4, containerName: 'footer', content: footerContent })
          )
        );
        if (outcome.status !== 'completed') return;
        if (outcome.value === false) {
          console.warn('[EvenG2Adapter] footer textContainerUpgrade returned false (will retry)');
        } else {
          this.lastFooterContent = footerContent;
        }
      } catch (error) {
        console.warn('[EvenG2Adapter] footer textContainerUpgrade error:', error);
        captureRuntimeError(error, 'even-g2-text-update', { container: 'footer' });
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
    if (!this.bridge || !this.isConnected || !this.pageReady || this.operationState.stalled) return;

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

      const outcome = await this.runNativeOperation(
        'speed-image',
        this.sessionEpoch,
        () => this.bridge.updateImageRawData(updateModel) as Promise<ImageRawDataUpdateResult>
      );
      if (outcome.status !== 'completed') return;

      const result = outcome.value;
      const resultStr = String(result);
      this.lastImageResult = resultStr;
      this.lastImageCompletedAtMs = Date.now();

      if (ImageRawDataUpdateResult.isSuccess(result)) {
        this.lastRenderedSpeedKmh = speedKmh;
        this.lastRenderedIsEstimated = isEstimated;
        this.lastImageUpdateTimeMs = Date.now();
        console.log('[Speed PNG Update Result]:', resultStr, `(${this.operationState.lastElapsedMs ?? 0}ms)`);
      } else {
        console.warn('[EvenG2Adapter] Speed image update non-success result:', resultStr);
      }
    } catch (err: any) {
      const errMessage = err?.message || String(err);
      this.lastImageResult = `error: ${errMessage}`;
      this.lastImageCompletedAtMs = Date.now();
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
        const outcome = await this.runNativeOperation('page-shutdown', this.sessionEpoch, () =>
          this.bridge.shutDownPageContainer(0)
        );
        if (outcome.status !== 'completed') return;
        if (!outcome.value) throw new Error('shutDownPageContainer failed');
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
        // A stall already owns rebuild + backoff. A parallel FOREGROUND_ENTER
        // recover would issue a second rebuild against the same page.
        if (this.isRecoveringTransport || this.operationState.stalled) return;
        void this.recoverPage('foreground-enter');
      } else if (
        eventType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
        eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT
      ) {
        this.markDisconnected(`OS exit event ${String(eventType)}`);
      }
    });
  }

  private async recoverPage(
    reason: BridgeRecoveryReason = 'foreground-enter'
  ): Promise<boolean> {
    // Once disconnected, the reconnect loop owns recovery: never resurrect the
    // session from a stale foreground event.
    if (!this.bridge || !this.isConnected) return false;
    // Bind this recovery to the session that is live right now. A slow BLE op can
    // hold bridgeQueue long enough for this session to die and the reconnect loop
    // to build a replacement, and createStartUpPageContainer does not go through
    // the queue — so by the time we run, `isConnected` may be true for a session
    // that was never ours.
    const epoch = this.sessionEpoch;
    this.recoveryCount += 1;
    this.lastRecoveryReason = reason;
    console.log(
      reason === 'foreground-enter'
        ? '[EvenG2Adapter] FOREGROUND_ENTER — rebuilding page containers'
        : '[EvenG2Adapter] transport-stall — rebuilding page containers'
    );

    let rebuiltThisSession = false;
    let stalledDuringRebuild = false;
    try {
      await this.enqueueBridgeOperation(async () => {
        // A disconnect — or a whole disconnect/reconnect cycle — may have landed
        // while this rebuild waited in the queue.
        if (!this.isConnected || this.sessionEpoch !== epoch) return;
        const outcome = await this.runNativeOperation('page-recover', epoch, () =>
          this.bridge.rebuildPageContainer(
            new RebuildPageContainer({ containerTotalNum: 4, ...this.createPageDefinition() })
          )
        );
        if (outcome.status === 'stalled') {
          stalledDuringRebuild = true;
          return;
        }
        if (outcome.status !== 'completed') return;
        if (!outcome.value) throw new Error('rebuildPageContainer failed');
        if (!this.isConnected || this.sessionEpoch !== epoch) return;
        this.resetHudCaches();
        this.flushedGeneration = 0;
        this.operationState.stalled = false;
        this.stalledEpoch = null;
        this.pageReady = true;
        this.isConnected = true;
        this.transportStatus = 'CONNECTED';
        rebuiltThisSession = true;
      }, epoch);
    } catch (error) {
      console.warn('[EvenG2Adapter] Page recovery failed:', error);
      captureRuntimeError(error, 'even-g2-page-recovery');
      // Only our own session's failure means "no usable page". If a newer session
      // already owns the bridge, tearing it down here would resolve its disconnect
      // waiter and cost a spurious reconnect cycle for a page we never built.
      // Stall-triggered failures are retried by runStallRecovery's backoff
      // instead of disconnecting on the first attempt.
      if (this.sessionEpoch === epoch && reason === 'foreground-enter') {
        this.markDisconnected('page recovery failed');
      }
      return false;
    }

    if (stalledDuringRebuild) return false;

    if (!rebuiltThisSession) {
      // Either the session was torn down outright, or it was torn down and a new
      // one took its place; both leave this recovery with no page of its own.
      console.log('[EvenG2Adapter] Skipped page recovery (its session is no longer current)');
      return false;
    }

    this.emitBridgeLifecycle('bridge-page-ready', {
      sessionEpoch: this.sessionEpoch,
      reason,
    });
    this.lastRecoveryAtMs = Date.now();

    if (this.lastModel) {
      // Force a fresh flush of the latest HUD after rebuild.
      this.renderGeneration += 1;
      this.hudDirty = true;
      this.scheduleHudFlush();
      return true;
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
    return true;
  }

  /**
   * Watchdog around a single native SDK call.
   *
   * The SDK has no cancel API, so the underlying promise is never abandoned:
   * a late settlement is attached as an epoch-guarded continuation for
   * telemetry only. The *wrapper* does settle on timeout — otherwise a hung
   * page-create / page-recover / page-shutdown would park connect(), the
   * recovery backoff, or AppController.stop() forever. By the time the
   * wrapper settles with `stalled`, handleTransportStall has already bumped
   * the session epoch and amputated the queue, so the next HUD op cannot
   * start because of the timeout.
   */
  private runNativeOperation<T>(
    kind: BridgeOperationKind,
    epoch: number,
    run: () => Promise<T>
  ): Promise<NativeOperationOutcome<T>> {
    this.operationState.sequence += 1;
    const sequence = this.operationState.sequence;
    const startedAtMs = Date.now();
    this.operationState.currentOperation = kind;
    this.operationState.currentStartedAtMs = startedAtMs;

    const pendingPromise = run();
    let watchdogFired = false;
    let wrapperSettled = false;

    return new Promise<NativeOperationOutcome<T>>((resolve, reject) => {
      const settle = (outcome: NativeOperationOutcome<T>): void => {
        if (wrapperSettled) return;
        wrapperSettled = true;
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        watchdogFired = true;
        void this.handleTransportStall(kind, sequence, epoch, pendingPromise);
        settle({ status: 'stalled' });
        this.attachLateContinuation(pendingPromise, kind, sequence, epoch, startedAtMs);
      }, this.timeoutMsFor(kind));

      pendingPromise.then(
        (value) => {
          if (watchdogFired) return;
          clearTimeout(timer);
          if (epoch !== this.sessionEpoch) {
            // A newer session owns the bridge. Recording lastResult / caches
            // here would leak the dead session's outcome into the live one.
            this.emitBridgeOperation({
              operation: kind,
              sequence,
              sessionEpoch: epoch,
              startedAtMs,
              completedAtMs: Date.now(),
              elapsedMs: Date.now() - startedAtMs,
              result: String(value),
            });
            settle({ status: 'stale' });
            return;
          }
          this.recordNativeCompletion(kind, sequence, epoch, startedAtMs, {
            ok: true,
            value,
          });
          settle({ status: 'completed', value });
        },
        (error) => {
          if (watchdogFired) return;
          clearTimeout(timer);
          if (epoch !== this.sessionEpoch) {
            this.emitBridgeOperation({
              operation: kind,
              sequence,
              sessionEpoch: epoch,
              startedAtMs,
              completedAtMs: Date.now(),
              elapsedMs: Date.now() - startedAtMs,
              error: error instanceof Error ? error.message : String(error),
            });
            settle({ status: 'stale' });
            return;
          }
          this.recordNativeCompletion(kind, sequence, epoch, startedAtMs, {
            ok: false,
            error,
          });
          if (wrapperSettled) return;
          wrapperSettled = true;
          reject(error);
        }
      );
    });
  }

  private attachLateContinuation<T>(
    pendingPromise: Promise<T>,
    kind: BridgeOperationKind,
    sequence: number,
    epoch: number,
    startedAtMs: number
  ): void {
    void pendingPromise.then(
      (value) => {
        const elapsedMs = Date.now() - startedAtMs;
        console.warn(
          `[EvenG2Adapter] Late native completion after stall: ${kind} seq=${sequence} elapsed=${elapsedMs}ms result=${String(value)}`
        );
        this.emitBridgeOperation({
          operation: kind,
          sequence,
          sessionEpoch: epoch,
          startedAtMs,
          completedAtMs: Date.now(),
          elapsedMs,
          result: String(value),
          stalled: true,
        });
      },
      (error) => {
        const elapsedMs = Date.now() - startedAtMs;
        console.warn(
          `[EvenG2Adapter] Late native error after stall: ${kind} seq=${sequence} elapsed=${elapsedMs}ms`,
          error
        );
        this.emitBridgeOperation({
          operation: kind,
          sequence,
          sessionEpoch: epoch,
          startedAtMs,
          completedAtMs: Date.now(),
          elapsedMs,
          stalled: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    );
  }

  private recordNativeCompletion(
    kind: BridgeOperationKind,
    sequence: number,
    epoch: number,
    startedAtMs: number,
    result: { ok: true; value: unknown } | { ok: false; error: unknown }
  ): void {
    const completedAtMs = Date.now();
    const elapsedMs = completedAtMs - startedAtMs;
    this.operationState.lastCompletedOperation = kind;
    this.operationState.lastCompletedAtMs = completedAtMs;
    this.operationState.lastElapsedMs = elapsedMs;
    this.operationState.currentOperation = null;
    this.operationState.currentStartedAtMs = null;

    const slow = elapsedMs >= this.slowWarnMsFor(kind);
    if (result.ok) {
      this.operationState.lastResult = String(result.value);
      this.operationState.lastError = null;
    } else {
      this.operationState.lastError =
        result.error instanceof Error ? result.error.message : String(result.error);
    }

    if (slow) {
      console.warn(
        `[EvenG2Adapter] Slow ${kind}: ${elapsedMs}ms` +
          (result.ok ? ` result=${String(result.value)}` : '')
      );
      this.emitBridgeLifecycle('bridge-operation-slow', {
        operation: kind,
        sequence,
        sessionEpoch: epoch,
        elapsedMs,
      });
    }

    this.emitBridgeOperation({
      operation: kind,
      sequence,
      sessionEpoch: epoch,
      startedAtMs,
      completedAtMs,
      elapsedMs,
      ...(result.ok ? { result: String(result.value) } : {}),
      ...(result.ok ? {} : { error: this.operationState.lastError ?? 'error' }),
      ...(slow ? { slow: true } : {}),
    });
  }

  private handleTransportStall(
    kind: BridgeOperationKind,
    sequence: number,
    epoch: number,
    pendingPromise: Promise<unknown>
  ): void {
    if (epoch !== this.sessionEpoch) return;
    if (this.stalledEpoch === epoch) return;

    this.stalledEpoch = epoch;
    this.operationState.stalled = true;
    this.transportStatus = 'STALLED';
    this.pageReady = false;
    this.lastRecoveryReason = 'transport-stall';
    this.healthyStreakStartedAtMs = null;

    // A flush that was scheduled or mid-body when the stall hit is skipped
    // by the epoch guard, so its body never runs its own cleanup — leaving
    // these flags stuck would make every later scheduleHudFlush() no-op.
    this.hudFlushScheduled = false;
    this.hudFlushInFlight = false;
    this.hudDirty = true;

    this.sessionEpoch += 1;
    this.bridgeQueue = Promise.resolve();

    this.emitBridgeOperation({
      operation: kind,
      sequence,
      sessionEpoch: epoch,
      startedAtMs: this.operationState.currentStartedAtMs ?? Date.now(),
      stalled: true,
    });
    this.emitBridgeLifecycle('bridge-operation-stalled', {
      operation: kind,
      sequence,
      sessionEpoch: epoch,
    });
    addRuntimeBreadcrumb(
      'railglance.bridge',
      'Even G2 transport stalled',
      { kind, sequence, epoch },
      'warning'
    );

    void this.runStallRecovery(pendingPromise);
  }

  private async runStallRecovery(pendingPromise: Promise<unknown>): Promise<void> {
    if (this.isRecoveringTransport) return;
    this.isRecoveringTransport = true;
    try {
      // Do not overlap old and new BLE work, but never depend on a promise
      // that may never settle. If the hung op finishes inside the grace
      // window we proceed with a quiet radio; if it does not, we rebuild
      // anyway and accept that one SDK promise may still be outstanding.
      await Promise.race([pendingPromise.then(() => {}, () => {}), delay(this.stallSettleGraceMs)]);

      for (const backoffMs of STALL_RECOVERY_BACKOFF_MS) {
        if (backoffMs > 0) await delay(backoffMs);
        if (!this.isConnected || !this.bridge) return;

        this.transportStatus = 'RECOVERING';
        const recoveredPromise = this.recoverPage('transport-stall');
        this.emitBridgeLifecycle('bridge-recovery-start', {
          reason: 'transport-stall',
          attempt: this.recoveryCount,
          sessionEpoch: this.sessionEpoch,
        });

        const recovered = await recoveredPromise;
        if (recovered) {
          this.operationState.stalled = false;
          this.stalledEpoch = null;
          this.transportStatus = 'CONNECTED';
          this.emitBridgeLifecycle('bridge-recovery-success', {
            reason: 'transport-stall',
            sessionEpoch: this.sessionEpoch,
            recoveryCount: this.recoveryCount,
          });
          return;
        }

        this.stallRecoveryFailures += 1;
        this.emitBridgeLifecycle('bridge-recovery-failed', {
          reason: 'transport-stall',
          sessionEpoch: this.sessionEpoch,
          failures: this.stallRecoveryFailures,
        });
      }

      this.markDisconnected('transport stall recovery exhausted');
    } finally {
      this.isRecoveringTransport = false;
    }
  }

  private noteHealthyFlush(): void {
    const now = Date.now();
    if (this.healthyStreakStartedAtMs === null) {
      this.healthyStreakStartedAtMs = now;
    }
    if (
      this.stallRecoveryFailures > 0 &&
      now - this.healthyStreakStartedAtMs >= RECOVERY_HEALTH_RESET_MS
    ) {
      this.stallRecoveryFailures = 0;
    }
  }

  private resetHudCaches(): void {
    this.lastHeaderContent = '';
    this.lastSegmentContent = '';
    this.lastFooterContent = '';
    this.lastRenderedSpeedKmh = null;
    this.lastRenderedIsEstimated = false;
    this.lastImageUpdateTimeMs = 0;
  }

  private timeoutMsFor(kind: BridgeOperationKind): number {
    switch (kind) {
      case 'speed-image':
        return this.imageOperationTimeoutMs;
      case 'page-create':
      case 'page-recover':
      case 'page-shutdown':
        return this.pageOperationTimeoutMs;
      default:
        return this.textOperationTimeoutMs;
    }
  }

  private slowWarnMsFor(kind: BridgeOperationKind): number {
    return kind === 'text-header' || kind === 'text-segment' || kind === 'text-footer'
      ? this.textSlowWarnMs
      : this.imageSlowWarnMs;
  }

  private emitBridgeOperation(payload: BridgeOperationTelemetryPayload): void {
    const telemetry = this.telemetry;
    if (!telemetry) return;
    telemetry.sink.write(
      createBridgeOperationTelemetryEvent(telemetry.identity, Date.now(), payload)
    );
  }

  private emitBridgeLifecycle(
    message: string,
    data: Record<string, string | number | boolean | null>
  ): void {
    const telemetry = this.telemetry;
    if (!telemetry) return;
    telemetry.sink.write(
      createStateTransitionTelemetryEvent(telemetry.identity, Date.now(), 'bridge', message, data)
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const MockEvenG2Adapter = HybridEvenG2Adapter;
