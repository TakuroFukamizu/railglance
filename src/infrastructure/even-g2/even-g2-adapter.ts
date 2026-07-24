import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
} from '@evenrealities/even_hub_sdk';
import { HudViewModel } from '../../domain/models/hud';
import { HudRenderer } from './hud-renderer';

export interface EvenG2Adapter {
  connect(): Promise<boolean>;
  render(model: HudViewModel): Promise<void>;
  clear(): Promise<void>;
}

export class HybridEvenG2Adapter implements EvenG2Adapter {
  private hudRenderer = new HudRenderer();
  private onRenderCallback?: (formattedText: string, model: HudViewModel) => void;
  private bridge: any = null;
  private isContainerCreated = false;

  constructor(onRender?: (formattedText: string, model: HudViewModel) => void) {
    this.onRenderCallback = onRender;
  }

  public async connect(): Promise<boolean> {
    try {
      // 1. Wait for EvenAppBridge initialization
      this.bridge = await waitForEvenAppBridge();
      console.log('[EvenG2Adapter] waitForEvenAppBridge() resolved successfully!');

      if (this.bridge) {
        // 2. Create StartUp Page Container on Even G2 Glasses screen
        const initialText = new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 4,
          containerID: 1,
          containerName: 'main',
          content: 'RailGlance Train HUD\nInitializing...',
          isEventCapture: 1,
        });

        const result = await this.bridge.createStartUpPageContainer(
          new CreateStartUpPageContainer({
            containerTotalNum: 1,
            textObject: [initialText],
          })
        );

        if (result === 0) {
          this.isContainerCreated = true;
          console.log('[EvenG2Adapter] Glasses StartUp Container created successfully!');
        } else {
          console.warn('[EvenG2Adapter] createStartUpPageContainer returned code:', result);
        }
      }
    } catch (err) {
      console.log('[EvenG2Adapter] Bridge connection notice (standalone browser/simulator mode):', err);
    }
    return true;
  }

  public async render(model: HudViewModel): Promise<void> {
    const formattedText = this.hudRenderer.formatHudText(model);

    // Render to Even G2 Glasses via SDK Bridge if container is active
    if (this.bridge && this.isContainerCreated) {
      try {
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 1,
            containerName: 'main',
            content: formattedText,
          })
        );
      } catch (err) {
        console.warn('[EvenG2Adapter] Error updating text via textContainerUpgrade:', err);
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
        this.isContainerCreated = false;
      } catch (err) {
        console.warn('[EvenG2Adapter] Error shutting down page container:', err);
      }
    }
    console.log('[EvenG2 HUD Output]: Cleared.');
  }
}

export const MockEvenG2Adapter = HybridEvenG2Adapter;
