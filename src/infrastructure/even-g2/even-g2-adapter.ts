import { HudViewModel } from '../../domain/models/hud';
import { HudRenderer } from './hud-renderer';

export interface EvenG2Adapter {
  connect(): Promise<boolean>;
  render(model: HudViewModel): Promise<void>;
  clear(): Promise<void>;
}

export class MockEvenG2Adapter implements EvenG2Adapter {
  private hudRenderer = new HudRenderer();
  private onRenderCallback?: (formattedText: string, model: HudViewModel) => void;

  constructor(onRender?: (formattedText: string, model: HudViewModel) => void) {
    this.onRenderCallback = onRender;
  }

  public async connect(): Promise<boolean> {
    console.log('[EvenG2Adapter] Connected to Even G2 SDK / Mock Adapter.');
    return true;
  }

  public async render(model: HudViewModel): Promise<void> {
    const formattedText = this.hudRenderer.formatHudText(model);
    console.log('[EvenG2 HUD Output]:\n' + formattedText);
    if (this.onRenderCallback) {
      this.onRenderCallback(formattedText, model);
    }
  }

  public async clear(): Promise<void> {
    console.log('[EvenG2 HUD Output]: Cleared.');
  }
}
