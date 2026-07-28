import { HudViewModel } from '../../domain/models/hud';

export class CanvasHudRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(private width = 576, private height = 288) {
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

    // 3. HEADER Region (Y: 12 to 46)
    // Left: Line Name (24px Bold)
    this.ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
    this.ctx.fillStyle = COLOR_SECONDARY;
    this.ctx.textAlign = 'left';
    this.ctx.fillText(header.lineName, 24, 34);

    // Right: Service / Direction (20px Bold)
    this.ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, sans-serif';
    this.ctx.textAlign = 'right';
    this.ctx.fillText(header.serviceOrDirection, 552, 34);

    // 4. SPEED Region (Y: 50 to 160)
    if (statusMode === 'LOST') {
      this.ctx.font = 'bold 104px -apple-system, BlinkMacSystemFont, monospace';
      this.ctx.fillStyle = COLOR_DISABLED;
      this.ctx.textAlign = 'center';
      this.ctx.fillText('--', 260, 135);

      this.ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
      this.ctx.fillStyle = COLOR_TERTIARY;
      this.ctx.fillText('km/h', 370, 135);
    } else {
      // Huge Speed Number (104px Bold Tabular Nums)
      this.ctx.font = 'bold 104px -apple-system, BlinkMacSystemFont, monospace';
      this.ctx.fillStyle = COLOR_PRIMARY;
      this.ctx.textAlign = 'center';

      const speedStr = speed.displaySpeedKmhText;
      const speedX = 260;
      this.ctx.fillText(speedStr, speedX, 135);

      // Speed Unit 'km/h' (24px)
      this.ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
      this.ctx.fillStyle = COLOR_TERTIARY;
      this.ctx.textAlign = 'left';
      const textMetrics = this.ctx.measureText(speedStr);
      const unitX = Math.min(480, speedX + textMetrics.width / 2 + 12);
      this.ctx.fillText('km/h', unitX, 135);

      // Estimated Mark '~' (28px)
      if (speed.isEstimated) {
        this.ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, sans-serif';
        this.ctx.fillStyle = COLOR_TERTIARY;
        this.ctx.fillText('~', unitX + 60, 135);
      }
    }

    // 5. SEGMENT Region (Y: 168 to 238)
    // Row 1: Previous & Next Station Names (24px)
    this.ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';

    // Previous Station (Left, Secondary Color)
    this.ctx.fillStyle = COLOR_SECONDARY;
    this.ctx.textAlign = 'left';
    this.ctx.fillText(segment.previousStationName, 24, 190);

    // Next Station (Right, Primary Color)
    this.ctx.fillStyle = COLOR_PRIMARY;
    this.ctx.textAlign = 'right';
    this.ctx.fillText(segment.nextStationName, 552, 190);

    // Row 2: Progress Bar (Y: 202, Height: 6px, Dot: 12x12px)
    const barX = 24;
    const barY = 202;
    const barW = 528;
    const barH = 6;

    // Track Background (Disabled Color)
    this.ctx.fillStyle = COLOR_DISABLED;
    this.ctx.beginPath();
    this.ctx.roundRect ? this.ctx.roundRect(barX, barY, barW, barH, 3) : this.ctx.rect(barX, barY, barW, barH);
    this.ctx.fill();

    if (segment.progressRatio !== null) {
      const clampedRatio = Math.max(0, Math.min(1, segment.progressRatio));
      const fillW = Math.max(6, barW * clampedRatio);

      // Progress Fill (Secondary Color)
      this.ctx.fillStyle = COLOR_SECONDARY;
      this.ctx.beginPath();
      this.ctx.roundRect ? this.ctx.roundRect(barX, barY, fillW, barH, 3) : this.ctx.rect(barX, barY, fillW, barH);
      this.ctx.fill();

      // Dot Marker (12x12 Circle, Primary Color)
      const dotX = barX + barW * clampedRatio;
      const dotY = barY + barH / 2;
      this.ctx.fillStyle = COLOR_PRIMARY;
      this.ctx.beginPath();
      this.ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
      this.ctx.fill();
    }

    // Row 3: Segment Info Row (18px)
    this.ctx.font = '500 18px -apple-system, BlinkMacSystemFont, sans-serif';
    this.ctx.fillStyle = COLOR_TERTIARY;

    // Left Info (e.g. "区間標準")
    this.ctx.textAlign = 'left';
    this.ctx.fillText(segment.segmentMaxSpeedText ?? '区間標準', 24, 230);

    // Right Info (e.g. "次まで 4.2km")
    this.ctx.textAlign = 'right';
    this.ctx.fillText(segment.distanceToNextText, 552, 230);

    // 6. FOOTER Region (Y: 244 to 272) (18px)
    this.ctx.font = '500 18px -apple-system, BlinkMacSystemFont, sans-serif';
    this.ctx.fillStyle = COLOR_TERTIARY;

    // Left Footer
    this.ctx.textAlign = 'left';
    this.ctx.fillText(footer.leftInfo, 24, 268);

    // Right Status
    this.ctx.textAlign = 'right';
    this.ctx.fillText(footer.statusRight, 552, 268);

    return this.canvas;
  }

  /**
   * Converts Canvas RGBA pixel data to Even G2 1bpp / Gray4 bitmap raw byte array
   */
  public getGray4BitmapBytes(): Uint8Array {
    if (!this.ctx) return new Uint8Array(0);

    const imgData = this.ctx.getImageData(0, 0, this.width, this.height);
    const pixels = imgData.data;

    // Even G2 Image raw data encoding (576 x 288)
    // 2-bit per pixel Gray4 encoding: 4 pixels per byte
    const totalBytes = (this.width * this.height) / 4;
    const output = new Uint8Array(totalBytes);

    let outIdx = 0;
    for (let i = 0; i < pixels.length; i += 16) {
      // Read 4 consecutive pixels (R component used for green brightness)
      const p0 = pixels[i] >> 6;       // 0 ~ 3
      const p1 = pixels[i + 4] >> 6;
      const p2 = pixels[i + 8] >> 6;
      const p3 = pixels[i + 12] >> 6;

      // Pack 4 pixels into 1 byte (2 bits each)
      output[outIdx++] = (p0 << 6) | (p1 << 4) | (p2 << 2) | p3;
    }

    return output;
  }
}
