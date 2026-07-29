export const SPEED_IMAGE_WIDTH = 200;
export const SPEED_IMAGE_HEIGHT = 100;

/**
 * Renders speed number on a 200x100 Canvas with black (#000) background (off/transparent on G2)
 * and encodes it to a standard Uint8Array PNG byte array.
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
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const speedStr = speedKmh !== null && speedKmh >= 0 ? `${Math.round(speedKmh)}` : '--';

  // 1. Speed Number (72px Bold system-ui / monospace for 200x100 canvas)
  ctx.font = '700 72px system-ui, -apple-system, monospace';
  const speedX = 100;
  const speedY = 42;
  ctx.fillText(speedStr, speedX, speedY);

  // 2. Speed Unit 'km/h' (18px SemiBold)
  ctx.font = '600 18px system-ui, -apple-system, sans-serif';
  ctx.fillText('km/h', speedX, 84);

  // 3. Estimated Mark '~' if dead-reckoning or interpolating
  if (isEstimated) {
    ctx.font = '700 20px system-ui, -apple-system, sans-serif';
    ctx.fillText('~', speedX + 55, 84);
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
