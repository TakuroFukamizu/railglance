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
  private canvasRenderer = new CanvasHudRenderer(288, 144);
  private onRenderCallback?: (formattedText: string, model: HudViewModel, canvas?: HTMLCanvasElement | null) => void;
  private bridge: any = null;
  private isConnected = false;
  private isImageModeActive = false;

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

        // Try single clean Image Container first (288x144 max viewport) to prevent text/image overlap
        const imageContainer = new ImageContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 288,
          height: 144,
          containerID: 1,
          containerName: 'main_img',
        });

        try {
          const result = await this.bridge.createStartUpPageContainer(
            new CreateStartUpPageContainer({
              containerTotalNum: 1,
              imageObject: [imageContainer],
            })
          );
          console.log('[EvenG2Adapter] createStartUpPageContainer Image mode result:', result);
          this.isImageModeActive = true;
        } catch (imgErr) {
          console.log('[EvenG2Adapter] Image container creation failed, falling back to clean Text mode:', imgErr);
          this.isImageModeActive = false;

          // Single clean Text Container fallback
          const textContainer = new TextContainerProperty({
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 288,
            borderWidth: 0,
            borderColor: 0,
            paddingLength: 0,
            containerID: 1,
            containerName: 'main_txt',
            content: 'RailGlance Train HUD\nReady',
            isEventCapture: 0,
          });

          await this.bridge.createStartUpPageContainer(
            new CreateStartUpPageContainer({
              containerTotalNum: 1,
              textObject: [textContainer],
            })
          );
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

    // Render exclusively to EITHER Image Container OR Text Container (never overlap both!)
    if (this.bridge && this.isConnected) {
      if (this.isImageModeActive && canvas) {
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
          console.warn('[EvenG2Adapter] Error updating Image raw data:', imgErr);
        }
      } else {
        try {
          await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: 1,
              containerName: 'main_txt',
              content: formattedText,
            })
          );
        } catch (txtErr) {
          console.warn('[EvenG2Adapter] Error upgrading text container:', txtErr);
        }
      }
    }

    // Console and Web Preview Output
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
