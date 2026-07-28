import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
} from '@evenrealities/even_hub_sdk';
import { HudViewModel } from '../../domain/models/hud';

export interface EvenG2Adapter {
  connect(): Promise<boolean>;
  render(model: HudViewModel): Promise<void>;
  clear(): Promise<void>;
}

export class HybridEvenG2Adapter implements EvenG2Adapter {
  private onRenderCallback?: (formattedText: string, model: HudViewModel) => void;
  private bridge: any = null;
  private isConnected = false;

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
        // Create 4 distinct Text Containers corresponding to the 4 HUD regions (Header, Speed, Segment, Footer)
        const headerContainer = new TextContainerProperty({
          xPosition: 24,
          yPosition: 12,
          width: 528,
          height: 34,
          borderWidth: 0,
          borderColor: 0,
          paddingLength: 0,
          containerID: 1,
          containerName: 'header',
          content: '小田急小田原線               上り',
          isEventCapture: 0,
        });

        const speedContainer = new TextContainerProperty({
          xPosition: 24,
          yPosition: 50,
          width: 528,
          height: 110,
          borderWidth: 0,
          borderColor: 0,
          paddingLength: 0,
          containerID: 2,
          containerName: 'speed',
          content: '       -- km/h',
          isEventCapture: 0,
        });

        const segmentContainer = new TextContainerProperty({
          xPosition: 24,
          yPosition: 168,
          width: 528,
          height: 70,
          borderWidth: 0,
          borderColor: 0,
          paddingLength: 0,
          containerID: 3,
          containerName: 'segment',
          content: '前駅不明 ━━━━━━●━━━━━━ 次駅推定中\n次まで --',
          isEventCapture: 0,
        });

        const footerContainer = new TextContainerProperty({
          xPosition: 24,
          yPosition: 244,
          width: 528,
          height: 28,
          borderWidth: 0,
          borderColor: 0,
          paddingLength: 0,
          containerID: 4,
          containerName: 'footer',
          content: '走行中                     GPS',
          isEventCapture: 0,
        });

        try {
          const result = await this.bridge.createStartUpPageContainer(
            new CreateStartUpPageContainer({
              containerTotalNum: 4,
              textObject: [headerContainer, speedContainer, segmentContainer, footerContainer],
            })
          );
          console.log('[EvenG2Adapter] createStartUpPageContainer result (4 containers):', result);
        } catch (cErr) {
          console.log('[EvenG2Adapter] Containers may already exist, proceeding to upgrade text:', cErr);
        }
      }
    } catch (err) {
      console.log('[EvenG2Adapter] Bridge connection notice (standalone browser/simulator mode):', err);
    }
    return true;
  }

  public async render(model: HudViewModel): Promise<void> {
    const formattedText = model.rawFormattedText;

    // Formulate regional content for the 4 containers
    const headerText = `${model.header.lineName}               ${model.header.serviceOrDirection}`;
    const estMark = model.speed.isEstimated ? ' ~' : '';
    const speedText = `       ${model.speed.displaySpeedKmhText} km/h${estMark}`;

    let progressBarStr = '━━━━━━━━━━━━';
    if (model.segment.progressRatio !== null) {
      const totalChars = 12;
      const dotIdx = Math.max(0, Math.min(totalChars - 1, Math.round(model.segment.progressRatio * (totalChars - 1))));
      const leftBar = '━'.repeat(dotIdx);
      const rightBar = '━'.repeat(totalChars - 1 - dotIdx);
      progressBarStr = `${leftBar}●${rightBar}`;
    }
    const segmentText = `${model.segment.previousStationName} ${progressBarStr} ${model.segment.nextStationName}\n${model.segment.distanceToNextText}`;
    const footerText = `${model.footer.leftInfo}                     ${model.footer.statusRight}`;

    // Upgrade all 4 text containers on Even G2 glasses display
    if (this.bridge && this.isConnected) {
      try {
        await Promise.all([
          this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'header', content: headerText })),
          this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: 'speed', content: speedText })),
          this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 3, containerName: 'segment', content: segmentText })),
          this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 4, containerName: 'footer', content: footerText })),
        ]);
      } catch (err) {
        console.warn('[EvenG2Adapter] Error upgrading 4 text containers:', err);
      }
    }

    // Console and Web Preview Output
    console.log('[EvenG2 HUD Output]:\n' + formattedText);
    if (this.onRenderCallback) {
      this.onRenderCallback(formattedText, model);
    }
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
