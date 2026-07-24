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
        // Attempt creating container on glasses display
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
          content: 'RailGlance Train HUD\nReady',
          isEventCapture: 1,
        });

        try {
          const result = await this.bridge.createStartUpPageContainer(
            new CreateStartUpPageContainer({
              containerTotalNum: 1,
              textObject: [initialText],
            })
          );
          console.log('[EvenG2Adapter] createStartUpPageContainer result:', result);
        } catch (cErr) {
          console.log('[EvenG2Adapter] Container may already exist, proceeding to upgrade text:', cErr);
        }
      }
    } catch (err) {
      console.log('[EvenG2Adapter] Bridge connection notice (standalone browser/simulator mode):', err);
    }
    return true;
  }

  public async render(model: HudViewModel): Promise<void> {
    const formattedText = this.hudRenderer.formatHudText(model);

    // Render to Even G2 Glasses via SDK Bridge whenever bridge is connected
    if (this.bridge && this.isConnected) {
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
      } catch (err) {
        console.warn('[EvenG2Adapter] Error shutting down page container:', err);
      }
    }
    console.log('[EvenG2 HUD Output]: Cleared.');
  }
}

export const MockEvenG2Adapter = HybridEvenG2Adapter;
