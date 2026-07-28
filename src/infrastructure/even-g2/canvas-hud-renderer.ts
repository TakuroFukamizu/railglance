import { HudViewModel } from '../../domain/models/hud';

export class CanvasHudRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(private width = 288, private height = 144) {
    if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = width;
      this.canvas.height = height;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    } else {
      this.canvas = null as any;
      this.ctx = null as any;
    }
  }

  public renderToCanvas(model: HudViewModel): HTMLCanvasElement | null {
    if (!this.ctx) return null;

    const { header, speed, segment, footer, statusMode } = model;

    // 1. Clear background to pure black (#000000)
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, this.width, this.height);

    // 2. Define Brightness Palette
    const COLOR_PRIMARY = '#00FF00';   // Level 15: Speed, Next Station
    const COLOR_SECONDARY = '#00BB00'; // Level 11: Line Name, Previous Station, Progress Fill
    const COLOR_TERTIARY = '#007700';  // Level 7: Units, Distances, Status Marks
    const COLOR_DISABLED = '#003300';  // Level 4: Inactive / Track

    this.ctx.textBaseline = 'alphabetic';

    // 3. HEADER Region (Y: 16)
    // Left: Line Name (13px Bold)
    this.ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
    this.ctx.fillStyle = COLOR_SECONDARY;
    this.ctx.textAlign = 'left';
    this.ctx.fillText(header.lineName, 10, 16);

    // Right: Service / Direction (12px Bold)
    this.ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
    this.ctx.textAlign = 'right';
    this.ctx.fillText(header.serviceOrDirection, 278, 16);

    // 4. SPEED Region (Y: 70)
    if (statusMode === 'LOST') {
      this.ctx.font = 'bold 56px -apple-system, BlinkMacSystemFont, monospace';
      this.ctx.fillStyle = COLOR_DISABLED;
      this.ctx.textAlign = 'center';
      this.ctx.fillText('--', 130, 70);

      this.ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
      this.ctx.fillStyle = COLOR_TERTIARY;
      this.ctx.fillText('km/h', 190, 70);
    } else {
      // Huge Speed Number (56px Bold Tabular Nums)
      this.ctx.font = 'bold 56px -apple-system, BlinkMacSystemFont, monospace';
      this.ctx.fillStyle = COLOR_PRIMARY;
      this.ctx.textAlign = 'center';

      const speedStr = speed.displaySpeedKmhText;
      const speedX = 130;
      this.ctx.fillText(speedStr, speedX, 70);

      // Speed Unit 'km/h' (14px)
      this.ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
      this.ctx.fillStyle = COLOR_TERTIARY;
      this.ctx.textAlign = 'left';
      const textMetrics = this.ctx.measureText(speedStr);
      const unitX = Math.min(230, speedX + textMetrics.width / 2 + 6);
      this.ctx.fillText('km/h', unitX, 70);

      // Estimated Mark '~' (16px)
      if (speed.isEstimated) {
        this.ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, sans-serif';
        this.ctx.fillStyle = COLOR_TERTIARY;
        this.ctx.fillText('~', unitX + 36, 70);
      }
    }

    // 5. SEGMENT Region (Y: 96 to 120)
    // Row 1: Previous & Next Station Names (13px)
    this.ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';

    // Previous Station (Left)
    this.ctx.fillStyle = COLOR_SECONDARY;
    this.ctx.textAlign = 'left';
    this.ctx.fillText(segment.previousStationName, 10, 96);

    // Next Station (Right)
    this.ctx.fillStyle = COLOR_PRIMARY;
    this.ctx.textAlign = 'right';
    this.ctx.fillText(segment.nextStationName, 278, 96);

    // Row 2: Progress Bar (Y: 102, Height: 4px, Dot: 8x8px)
    const barX = 10;
    const barY = 102;
    const barW = 268;
    const barH = 4;

    this.ctx.fillStyle = COLOR_DISABLED;
    this.ctx.beginPath();
    this.ctx.rect(barX, barY, barW, barH);
    this.ctx.fill();

    if (segment.progressRatio !== null) {
      const clampedRatio = Math.max(0, Math.min(1, segment.progressRatio));
      const fillW = Math.max(4, barW * clampedRatio);

      this.ctx.fillStyle = COLOR_SECONDARY;
      this.ctx.beginPath();
      this.ctx.rect(barX, barY, fillW, barH);
      this.ctx.fill();

      const dotX = barX + barW * clampedRatio;
      const dotY = barY + barH / 2;
      this.ctx.fillStyle = COLOR_PRIMARY;
      this.ctx.beginPath();
      this.ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
      this.ctx.fill();
    }

    // Row 3: Segment Info Row (10px)
    this.ctx.font = '500 10px -apple-system, BlinkMacSystemFont, sans-serif';
    this.ctx.fillStyle = COLOR_TERTIARY;

    this.ctx.textAlign = 'left';
    this.ctx.fillText(segment.segmentMaxSpeedText ?? '区間標準', 10, 118);

    this.ctx.textAlign = 'right';
    this.ctx.fillText(segment.distanceToNextText, 278, 118);

    // 6. FOOTER Region (Y: 136) (10px)
    this.ctx.font = '500 10px -apple-system, BlinkMacSystemFont, sans-serif';
    this.ctx.fillStyle = COLOR_TERTIARY;

    this.ctx.textAlign = 'left';
    this.ctx.fillText(footer.leftInfo, 10, 136);

    this.ctx.textAlign = 'right';
    this.ctx.fillText(footer.statusRight, 278, 136);

    return this.canvas;
  }

  /**
   * Converts Canvas RGBA pixel data to Even G2 Gray4 bitmap raw byte array (288 x 144)
   */
  public getGray4BitmapBytes(): Uint8Array {
    if (!this.ctx) return new Uint8Array(0);

    const imgData = this.ctx.getImageData(0, 0, this.width, this.height);
    const pixels = imgData.data;

    // 2-bit per pixel Gray4 encoding: 4 pixels per byte
    const totalBytes = (this.width * this.height) / 4;
    const output = new Uint8Array(totalBytes);

    let outIdx = 0;
    for (let i = 0; i < pixels.length; i += 16) {
      const p0 = pixels[i] >> 6;       // 0 ~ 3
      const p1 = pixels[i + 4] >> 6;
      const p2 = pixels[i + 8] >> 6;
      const p3 = pixels[i + 12] >> 6;

      output[outIdx++] = (p0 << 6) | (p1 << 4) | (p2 << 2) | p3;
    }

    return output;
  }
}
