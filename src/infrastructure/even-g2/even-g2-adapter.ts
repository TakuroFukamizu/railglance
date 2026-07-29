import {
  waitForEvenAppBridge,
  ImageContainerProperty,
  ImageRawDataUpdate,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
} from '@evenrealities/even_hub_sdk';
import { HudViewModel } from '../../domain/models/hud';
import { createSpeedPng } from './speed-png-generator';

export interface EvenG2Adapter {
  connect(): Promise<boolean>;
  render(model: HudViewModel): Promise<void>;
  clear(): Promise<void>;
}

export class HybridEvenG2Adapter implements EvenG2Adapter {
  private onRenderCallback?: (formattedText: string, model: HudViewModel) => void;
  private bridge: any = null;
  private isConnected = false;
  private pageReady = false;

  private bridgeQueue: Promise<void> = Promise.resolve();

  private lastHeaderContent = '';
  private lastSegmentContent = '';
  private lastFooterContent = '';

  private lastRenderedSpeedKmh: number | null = null;
  private lastRenderedIsEstimated = false;
  private lastImageUpdateTimeMs = 0;
  private readonly SPEED_IMAGE_MIN_INTERVAL_MS = 500; // 2Hz max image rate

  constructor(onRender?: (formattedText: string, model: HudViewModel) => void) {
    this.onRenderCallback = onRender;
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
        // Hybrid Layout with non-overlapping Y-regions:
        // Y: 0~44 -> TextContainer (ID 1, zOrder: 1, isEventCapture: 1)
        // Y: 70~170 -> ImageContainer (ID 2, zOrder: 2, X: 188, W: 200, H: 100)
        // Y: 196~244 -> TextContainer (ID 3, zOrder: 3)
        // Y: 248~288 -> TextContainer (ID 4, zOrder: 4)

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

        const result = await this.bridge.createStartUpPageContainer(
          new CreateStartUpPageContainer({
            containerTotalNum: 4,
            textObject: [headerContainer, segmentContainer, footerContainer],
            imageObject: [speedImageContainer],
          })
        );

        console.log('[EvenG2Adapter] createStartUpPageContainer result:', {
          result,
          type: typeof result,
        });

        const isSuccess = result === 0 || result === '0' || result === 'APP_REQUEST_CREATE_PAGE_SUCCESS';

        if (!isSuccess) {
          this.isConnected = false;
          this.pageReady = false;
          throw new Error(`createStartUpPageContainer failed with code: ${String(result)}`);
        }

        this.pageReady = true;
        this.isConnected = true;

        // Synchronously await initial PNG speed image transmission
        await this.queueSpeedImageUpdate(null, false, true);
      }
    } catch (err) {
      console.log('[EvenG2Adapter] Bridge connection notice:', err);
    }
    return this.isConnected;
  }

  public async render(model: HudViewModel): Promise<void> {
    const formattedText = model.rawFormattedText;
    const now = Date.now();

    // Parse speed integer
    const rawSpeedVal = model.speed.displaySpeedKmhText === '--' ? null : parseInt(model.speed.displaySpeedKmhText, 10);
    const speedKmh = isNaN(rawSpeedVal as any) ? null : rawSpeedVal;
    const isEstimated = model.speed.isEstimated;

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
          await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: 1, containerName: 'header', content: headerContent })
          );
          this.lastHeaderContent = headerContent;
        }

        if (segmentContent !== this.lastSegmentContent) {
          await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: 3, containerName: 'segment', content: segmentContent })
          );
          this.lastSegmentContent = segmentContent;
        }

        if (footerContent !== this.lastFooterContent) {
          await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: 4, containerName: 'footer', content: footerContent })
          );
          this.lastFooterContent = footerContent;
        }
      });

      // 2. Sequentially enqueue PNG speed image update if value changed and rate limit met
      const isSpeedChanged = speedKmh !== this.lastRenderedSpeedKmh || isEstimated !== this.lastRenderedIsEstimated;
      const isTimeElapsed = now - this.lastImageUpdateTimeMs >= this.SPEED_IMAGE_MIN_INTERVAL_MS;

      if (isSpeedChanged && isTimeElapsed) {
        this.lastImageUpdateTimeMs = now;
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
   * Queues PNG speed image update strictly sequentially inside bridgeQueue.
   */
  private queueSpeedImageUpdate(speedKmh: number | null, isEstimated: boolean, force = false): Promise<void> {
    return this.enqueueBridgeOperation(async () => {
      if (!this.bridge || !this.isConnected || !this.pageReady) return;

      if (!force && speedKmh === this.lastRenderedSpeedKmh && isEstimated === this.lastRenderedIsEstimated) {
        return;
      }

      try {
        const pngUint8Array = await createSpeedPng(speedKmh, isEstimated);

        console.log('[Speed PNG Info]', {
          length: pngUint8Array.byteLength,
          signature: Array.from(pngUint8Array.slice(0, 8)),
          expectedSignature: [137, 80, 78, 71, 13, 10, 26, 10],
        });

        const result = await this.bridge.updateImageRawData(
          new ImageRawDataUpdate({
            containerID: 2,
            containerName: 'speed_img',
            imageData: pngUint8Array, // Directly pass Uint8Array
          })
        );

        console.log('[Speed PNG Update Result]:', result);

        if (result === 'success' || result === 0 || result === 'APP_REQUEST_UPGRADE_IMAGE_RAW_DATA_SUCCESS') {
          this.lastRenderedSpeedKmh = speedKmh;
          this.lastRenderedIsEstimated = isEstimated;
        } else {
          console.warn('[EvenG2Adapter] Speed image update non-success result:', result);
        }
      } catch (err) {
        console.warn('[EvenG2Adapter] Error in speed image update operation:', err);
      }
    });
  }

  public async clear(): Promise<void> {
    if (this.bridge && typeof this.bridge.shutDownPageContainer === 'function') {
      try {
        await this.bridge.shutDownPageContainer(1);
      } catch (err) {
        console.warn('[EvenG2Adapter] Error shutting down page container:', err);
      }
    }
    this.pageReady = false;
    console.log('[EvenG2 HUD Output]: Cleared.');
  }
}

export const MockEvenG2Adapter = HybridEvenG2Adapter;
