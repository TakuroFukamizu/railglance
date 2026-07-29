export const SPEED_IMAGE_WIDTH = 288;
export const SPEED_IMAGE_HEIGHT = 144;

/**
 * Renders speed number on a 288x144 Canvas with black (#000) background (off/transparent on G2)
 * and encodes it to a standard PNG byte array (number[]) as required by Even Hub SDK.
 */
export async function createSpeedPng(
  speedKmh: number | null,
  isEstimated: boolean = false
): Promise<number[]> {
  if (typeof document === 'undefined') {
    return [];
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

  // 1. Huge Speed Number (104px Bold system-ui / monospace)
  ctx.font = '700 104px system-ui, -apple-system, monospace';
  const speedX = 144;
  const speedY = 64;
  ctx.fillText(speedStr, speedX, speedY);

  // 2. Speed Unit 'km/h' (22px SemiBold)
  ctx.font = '600 22px system-ui, -apple-system, sans-serif';
  ctx.fillText('km/h', speedX, 122);

  // 3. Estimated Mark '~' if dead-reckoning or interpolating
  if (isEstimated) {
    ctx.font = '700 24px system-ui, -apple-system, sans-serif';
    ctx.fillText('~', speedX + 80, 122);
  }

  // Encode Canvas to standard PNG Blob byte array
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error('PNG encoding failed'));
    }, 'image/png');
  });

  const arrayBuffer = await blob.arrayBuffer();
  return Array.from(new Uint8Array(arrayBuffer));
}
