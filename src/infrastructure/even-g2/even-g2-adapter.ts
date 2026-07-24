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
  private isSdkAvailable = false;

  constructor(onRender?: (formattedText: string, model: HudViewModel) => void) {
    this.onRenderCallback = onRender;
  }

  public async connect(): Promise<boolean> {
    // Check if EvenAppBridge / EvenHub SDK environment is present (Simulator or Real App)
    if (typeof window !== 'undefined' && (window as any).evenAppBridge) {
      this.isSdkAvailable = true;
      console.log('[EvenG2Adapter] Connected via EvenHub SDK / Simulator Bridge.');
    } else {
      console.log('[EvenG2Adapter] Connected via Local Mock / Web Simulator.');
    }
    return true;
  }

  public async render(model: HudViewModel): Promise<void> {
    const formattedText = this.hudRenderer.formatHudText(model);

    // 1. Send to EvenHub SDK Bridge if available
    if (this.isSdkAvailable && (window as any).evenAppBridge) {
      try {
        const bridge = (window as any).evenAppBridge;
        if (typeof bridge.textContainerUpgrade === 'function') {
          bridge.textContainerUpgrade({
            containerID: 1,
            content: formattedText,
          });
        } else if (typeof bridge.callMethod === 'function') {
          bridge.callMethod('textContainerUpgrade', {
            containerID: 1,
            content: formattedText,
          });
        }
      } catch (err) {
        console.warn('[EvenG2Adapter] Error rendering text to SDK bridge:', err);
      }
    }

    // 2. Local Web Preview & Console output
    console.log('[EvenG2 HUD Output]:\n' + formattedText);
    if (this.onRenderCallback) {
      this.onRenderCallback(formattedText, model);
    }
  }

  public async clear(): Promise<void> {
    if (this.isSdkAvailable && (window as any).evenAppBridge) {
      try {
        const bridge = (window as any).evenAppBridge;
        if (typeof bridge.shutDownPageContainer === 'function') {
          bridge.shutDownPageContainer();
        }
      } catch (err) {
        console.warn('[EvenG2Adapter] Error clearing SDK container:', err);
      }
    }
    console.log('[EvenG2 HUD Output]: Cleared.');
  }
}

// Keep MockEvenG2Adapter for compatibility
export const MockEvenG2Adapter = HybridEvenG2Adapter;
