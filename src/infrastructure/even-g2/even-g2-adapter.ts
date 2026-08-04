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

export interface EvenG2Adapter {
  connect(): Promise<boolean>;
  render(model: HudViewModel): Promise<void>;
  clear(): Promise<void>;
  getLastImageResult(): string;
}

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

  constructor(onRender?: (formattedText: string, model: HudViewModel) => void) {
    this.onRenderCallback = onRender;
  }

  public getLastImageResult(): string {
    return this.lastImageResult;
  }

  /**
   * Enqueues all BLE bridge operations into a single strict sequential execution queue.
   */
  private enqueueBridgeOperation(operation: () => Promise<void>): Promise<void> {
    this.bridgeQueue = this.bridgeQueue
      .catch((error) => {
        console.warn('[EvenG2Adapter] Previous bridge operation failed:', error);
      })
      .then(operation);

    return this.bridgeQueue;
  }

  public async connect(): Promise<boolean> {
    try {
      if (!this.bridge) {
        this.bridge = await waitForEvenAppBridge();
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
        this.pageReady = true;
        this.isConnected = true;
        this.subscribeToLifecycleEvents();

        // Create image content only after the page is ready. The SDK requires
        // updateImageRawData calls to remain serial until the native promise settles.
        try {
          await this.queueSpeedImageUpdate(null, false, true);
        } catch (imgErr) {
          console.warn('[EvenG2Adapter] Initial speed PNG update notice (continuing TextContainer & GPS updates):', imgErr);
        }
      }
    } catch (err) {
      console.log('[EvenG2Adapter] Bridge connection notice:', err);
    }
    return this.isConnected;
  }

  public async render(model: HudViewModel): Promise<void> {
    this.lastModel = model;
    const formattedText = model.rawFormattedText;
    const now = Date.now();

    // Parse speed integer
    const rawSpeedVal = model.speed.displaySpeedKmhText === '--' ? null : parseInt(model.speed.displaySpeedKmhText, 10);
    const speedKmh = isNaN(rawSpeedVal as any) ? null : rawSpeedVal;
    const isEstimated = model.speed.isEstimated;
    this.latestRequestedSpeedKmh = speedKmh;
    this.latestRequestedIsEstimated = isEstimated;

    if (this.bridge && this.isConnected && this.pageReady) {
      const headerContent = `${model.header.lineName}               ${model.header.serviceOrDirection}`;

      let progressBarStr = '━━━━━━━━━━━━';
      if (model.segment.progressRatio !== null) {
        const totalChars = 12;
        const dotIdx = Math.max(0, Math.min(totalChars - 1, Math.round(model.segment.progressRatio * (totalChars - 1))));
        const leftBar = '━'.repeat(dotIdx);
        const rightBar = '━'.repeat(totalChars - 1 - dotIdx);
        progressBarStr = `${leftBar}●${rightBar}`;
      }
      const segmentContent = `${model.segment.previousStationName} ${progressBarStr} ${model.segment.nextStationName}`;
      const footerContent = `${model.segment.distanceToNextText}               ${model.footer.statusRight}`;

      // 1. Sequentially upgrade only changed TextContainers via single bridgeQueue
      await this.enqueueBridgeOperation(async () => {
        if (headerContent !== this.lastHeaderContent) {
          const updated = await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: 1, containerName: 'header', content: headerContent })
          );
          if (!updated) throw new Error('header textContainerUpgrade failed');
          this.lastHeaderContent = headerContent;
        }

        if (segmentContent !== this.lastSegmentContent) {
          const updated = await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: 3, containerName: 'segment', content: segmentContent })
          );
          if (!updated) throw new Error('segment textContainerUpgrade failed');
          this.lastSegmentContent = segmentContent;
        }

        if (footerContent !== this.lastFooterContent) {
          const updated = await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: 4, containerName: 'footer', content: footerContent })
          );
          if (!updated) throw new Error('footer textContainerUpgrade failed');
          this.lastFooterContent = footerContent;
        }
      });

      // 2. Sequentially enqueue PNG speed image update if value changed and rate limit met
      const isSpeedChanged = speedKmh !== this.lastRenderedSpeedKmh || isEstimated !== this.lastRenderedIsEstimated;
      const isTimeElapsed = now - this.lastImageUpdateTimeMs >= this.SPEED_IMAGE_MIN_INTERVAL_MS;

      if (isSpeedChanged && isTimeElapsed) {
        await this.queueSpeedImageUpdate(speedKmh, isEstimated);
      }
    }

    // Console and Web Preview Output
    console.log('[EvenG2 HUD Output]:\n' + formattedText);
    if (this.onRenderCallback) {
      this.onRenderCallback(formattedText, model);
    }
  }

  /**
   * Queues PNG speed image updates strictly sequentially. A native operation is
   * never timed out locally because the SDK does not expose cancellation; moving
   * the queue after a Promise.race would allow two BLE operations in flight.
   */
  private queueSpeedImageUpdate(speedKmh: number | null, isEstimated: boolean, force = false): Promise<void> {
    return this.enqueueBridgeOperation(async () => {
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

        const result = await this.bridge.updateImageRawData(updateModel);
        const resultStr = String(result);
        this.lastImageResult = resultStr;

        console.log('[Speed PNG Update Result]:', resultStr);

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
    this.isConnected = false;
    this.pageReady = false;
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
        this.pageReady = false;
      } else if (eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
        void this.recoverPage();
      } else if (
        eventType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
        eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT
      ) {
        this.pageReady = false;
        this.isConnected = false;
      }
    });
  }

  private async recoverPage(): Promise<void> {
    if (!this.bridge) return;
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
        this.pageReady = true;
        this.isConnected = true;
      });
      if (this.lastModel) {
        await this.render(this.lastModel);
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
