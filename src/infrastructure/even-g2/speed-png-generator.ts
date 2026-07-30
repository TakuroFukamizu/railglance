export const SPEED_IMAGE_WIDTH = 200;
export const SPEED_IMAGE_HEIGHT = 100;

/**
 * Renders speed number on a 200x100 Canvas with black (#000) background (off/transparent on G2).
 * Mathematically centers the entire speed group (number + unit + estimated mark) exactly in the horizontal middle (X: 100).
 */
export async function createSpeedPng(
  speedKmh: number | null,
  isEstimated = false
): Promise<Uint8Array> {
  if (typeof document === 'undefined') {
    return new Uint8Array(0);
  }

  const canvas = document.createElement('canvas');
  canvas.width = SPEED_IMAGE_WIDTH;
  canvas.height = SPEED_IMAGE_HEIGHT;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context is unavailable');
  }

  // Black background translates to off/transparent pixels on Even G2 display
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#ffffff';

  const speedStr = speedKmh !== null && speedKmh >= 0 ? `${Math.round(speedKmh)}` : '--';

  // Fonts
  const speedFont = '700 70px system-ui, -apple-system, monospace';
  const unitFont = '600 18px system-ui, -apple-system, sans-serif';
  const estFont = '700 20px system-ui, -apple-system, sans-serif';

  // Measure components for exact horizontal centering
  ctx.font = speedFont;
  const speedWidth = ctx.measureText(speedStr).width;

  ctx.font = unitFont;
  const unitWidth = ctx.measureText('km/h').width;

  ctx.font = estFont;
  const estWidth = isEstimated ? ctx.measureText(' ~').width : 0;

  const spacing = 4;
  const totalWidth = speedWidth + spacing + unitWidth + estWidth;

  // Calculate start X to center the entire combined block horizontally in 200px canvas
  let currentX = Math.round((SPEED_IMAGE_WIDTH - totalWidth) / 2);

  // 1. Draw Speed Number
  ctx.font = speedFont;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const speedY = 70;
  ctx.fillText(speedStr, currentX, speedY);

  currentX += speedWidth + spacing;

  // 2. Draw Speed Unit 'km/h'
  ctx.font = unitFont;
  const unitY = 68;
  ctx.fillText('km/h', currentX, unitY);

  currentX += unitWidth;

  // 3. Draw Estimated Mark '~' if active
  if (isEstimated) {
    ctx.font = estFont;
    ctx.fillText(' ~', currentX, unitY);
  }

  // Encode Canvas to standard PNG Blob Uint8Array
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error('PNG encoding failed'));
    }, 'image/png');
  });

  const arrayBuffer = await blob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
