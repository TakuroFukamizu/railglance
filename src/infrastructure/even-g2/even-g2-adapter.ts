import {
  waitForEvenAppBridge,
  ImageContainerProperty,
  ImageRawDataUpdate,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
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

  private imageUpdateQueue: Promise<void> = Promise.resolve();
  private lastRenderedSpeedKmh: number | null = null;
  private lastRenderedIsEstimated: boolean = false;
  private lastImageUpdateTimeMs = 0;
  private readonly SPEED_IMAGE_MIN_INTERVAL_MS = 500; // 2Hz max image rate

  constructor(onRender?: (formattedText: string, model: HudViewModel) => void) {
    this.onRenderCallback = onRender;
  }

  public async connect(): Promise<boolean> {
    try {
      if (!this.bridge) {
        this.bridge = await waitForEvenAppBridge();
        console.log('[EvenG2Adapter] waitForEvenAppBridge() resolved!');
      }

      if (this.bridge) {
        this.isConnected = true;

        // Hybrid Layout with non-overlapping Y-regions:
        // Y: 0~44 -> TextContainer (ID 1, zOrder: 1, isEventCapture: 1)
        // Y: 48~192 -> ImageContainer (ID 2, zOrder: 2, X: 144, W: 288, H: 144)
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
          xPosition: 144,
          yPosition: 48,
          width: 288,
          height: 144,
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

        try {
          const result = await this.bridge.createStartUpPageContainer(
            new CreateStartUpPageContainer({
              containerTotalNum: 4,
              textObject: [headerContainer, segmentContainer, footerContainer],
              imageObject: [speedImageContainer],
            })
          );
          console.log('[EvenG2Adapter] createStartUpPageContainer result:', result);

          if (result === StartUpPageCreateResult.success || result === 0) {
            // Initial PNG speed image transmission after container creation success
            void this.queueSpeedImageUpdate(null, false, true);
          }
        } catch (cErr) {
          console.log('[EvenG2Adapter] Page creation notice (already exists):', cErr);
        }
      }
    } catch (err) {
      console.log('[EvenG2Adapter] Bridge connection notice (standalone browser/simulator mode):', err);
    }
    return true;
  }

  public async render(model: HudViewModel): Promise<void> {
    const formattedText = model.rawFormattedText;
    const now = Date.now();

    // Parse speed integer
    const rawSpeedVal = model.speed.displaySpeedKmhText === '--' ? null : parseInt(model.speed.displaySpeedKmhText, 10);
    const speedKmh = isNaN(rawSpeedVal as any) ? null : rawSpeedVal;
    const isEstimated = model.speed.isEstimated;

    // Fast native TextContainer updates for Header, Segment (with Unicode progress bar), and Footer
    if (this.bridge && this.isConnected) {
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

      try {
        await Promise.all([
          this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'header', content: headerContent })),
          this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 3, containerName: 'segment', content: segmentContent })),
          this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 4, containerName: 'footer', content: footerContent })),
        ]);
      } catch (err) {
        console.warn('[EvenG2Adapter] Error upgrading text containers:', err);
      }

      // Check if Speed PNG update is required (max 2Hz & integer/estimation change)
      const isSpeedChanged = speedKmh !== this.lastRenderedSpeedKmh || isEstimated !== this.lastRenderedIsEstimated;
      const isTimeElapsed = now - this.lastImageUpdateTimeMs >= this.SPEED_IMAGE_MIN_INTERVAL_MS;

      if (isSpeedChanged && isTimeElapsed) {
        this.lastImageUpdateTimeMs = now;
        void this.queueSpeedImageUpdate(speedKmh, isEstimated);
      }
    }

    // Console and Web Preview Output
    console.log('[EvenG2 HUD Output]:\n' + formattedText);
    if (this.onRenderCallback) {
      this.onRenderCallback(formattedText, model);
    }
  }

  /**
   * Queues PNG speed image update to ensure strict sequential execution (await completion).
   */
  private queueSpeedImageUpdate(speedKmh: number | null, isEstimated: boolean, force = false): Promise<void> {
    this.imageUpdateQueue = this.imageUpdateQueue.then(async () => {
      if (!this.bridge || !this.isConnected) return;

      if (!force && speedKmh === this.lastRenderedSpeedKmh && isEstimated === this.lastRenderedIsEstimated) {
        return;
      }

      try {
        const pngBytes = await createSpeedPng(speedKmh, isEstimated);
        const result = await this.bridge.updateImageRawData(
          new ImageRawDataUpdate({
            containerID: 2,
            containerName: 'speed_img',
            imageData: pngBytes, // number[] byte array of PNG file
          })
        );

        if (result === 'success' || result === 0) {
          this.lastRenderedSpeedKmh = speedKmh;
          this.lastRenderedIsEstimated = isEstimated;
        } else {
          console.warn('[EvenG2Adapter] Speed image update result:', result);
        }
      } catch (err) {
        console.warn('[EvenG2Adapter] Error in speed image update:', err);
      }
    });

    return this.imageUpdateQueue;
  }

  public async clear(): Promise<void> {
    if (this.bridge && typeof this.bridge.shutDownPageContainer === 'function') {
      try {
        await this.bridge.shutDownPageContainer(1);
      } catch (err) {
        console.warn('[EvenG2Adapter] Error shutting down page container:', err);
      }
    }
    console.log('[EvenG2 HUD Output]: Cleared.');
  }
}

export const MockEvenG2Adapter = HybridEvenG2Adapter;
