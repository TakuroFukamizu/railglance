import {
  waitForEvenAppBridge,
  ImageContainerProperty,
  ImageRawDataUpdate,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
} from '@evenrealities/even_hub_sdk';
import { HudViewModel } from '../../domain/models/hud';
import { CanvasHudRenderer } from './canvas-hud-renderer';

export interface EvenG2Adapter {
  connect(): Promise<boolean>;
  render(model: HudViewModel): Promise<void>;
  clear(): Promise<void>;
}

export class HybridEvenG2Adapter implements EvenG2Adapter {
  private canvasRenderer = new CanvasHudRenderer(576, 288);
  private onRenderCallback?: (formattedText: string, model: HudViewModel, canvas?: HTMLCanvasElement | null) => void;
  private bridge: any = null;
  private isConnected = false;

  constructor(onRender?: (formattedText: string, model: HudViewModel, canvas?: HTMLCanvasElement | null) => void) {
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

        // Create Image Container (576x288 / 288x144 max viewport) for full graphic rendering
        const imageContainer = new ImageContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 288,
          height: 144,
          containerID: 1,
          containerName: 'main_img',
        });

        const textContainer = new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 0,
          borderColor: 0,
          paddingLength: 0,
          containerID: 2,
          containerName: 'main_txt',
          content: 'RailGlance Train HUD\nReady',
          isEventCapture: 0,
        });

        try {
          const result = await this.bridge.createStartUpPageContainer(
            new CreateStartUpPageContainer({
              containerTotalNum: 2,
              imageObject: [imageContainer],
              textObject: [textContainer],
            })
          );
          console.log('[EvenG2Adapter] createStartUpPageContainer result (Image & Text containers):', result);
        } catch (cErr) {
          console.log('[EvenG2Adapter] Container creation notice:', cErr);
        }
      }
    } catch (err) {
      console.log('[EvenG2Adapter] Bridge connection notice (standalone browser/simulator mode):', err);
    }
    return true;
  }

  public async render(model: HudViewModel): Promise<void> {
    const formattedText = model.rawFormattedText;
    const canvas = this.canvasRenderer.renderToCanvas(model);

    // 1. Render Graphic Image to Even G2 Glasses if bridge is connected
    if (this.bridge && this.isConnected && canvas) {
      try {
        const rawBytes = this.canvasRenderer.getGray4BitmapBytes();

        if (typeof this.bridge.updateImageRawData === 'function') {
          await this.bridge.updateImageRawData(
            new ImageRawDataUpdate({
              containerID: 1,
              containerName: 'main_img',
              imageData: Array.from(rawBytes),
            })
          );
        }
      } catch (imgErr) {
        console.warn('[EvenG2Adapter] Image update notice, falling back to text upgrade:', imgErr);
      }

      // Fallback text upgrade for text-only bridge mode
      try {
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 2,
            containerName: 'main_txt',
            content: formattedText,
          })
        );
      } catch (txtErr) {
        // Ignore fallback notice
      }
    }

    // 2. Console and Web Preview Output
    console.log('[EvenG2 HUD Output]:\n' + formattedText);
    if (this.onRenderCallback) {
      this.onRenderCallback(formattedText, model, canvas);
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
