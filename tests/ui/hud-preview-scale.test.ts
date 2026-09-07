import { describe, expect, it, vi } from 'vitest';
import { attachPreviewScaler, computePreviewScale } from '../../src/ui/hud-preview-scale';

describe('computePreviewScale', () => {
  it.each([
    [320, 320 / 576],
    [375, 375 / 576],
    [576, 1],
    [800, 1],
  ])('width %d → scale %f (capped at 1)', (width, expected) => {
    expect(computePreviewScale(width)).toBeCloseTo(expected, 6);
  });

  it('treats a non-positive width as unscaled', () => {
    expect(computePreviewScale(0)).toBe(1);
    expect(computePreviewScale(-5)).toBe(1);
  });
});

describe('attachPreviewScaler', () => {
  function setup(widths: number[]) {
    const root = { style: {} as { transform?: string } };
    const frames: Array<() => void> = [];
    const scaler = attachPreviewScaler({
      measureWidth: () => widths.shift() ?? 0,
      root,
      requestFrame: (cb) => {
        frames.push(cb);
      },
      observe: undefined,
    });
    return { scaler, root, frames };
  }

  it('applies the scale on refresh', () => {
    const { scaler, root } = setup([288]);
    scaler.refresh();
    expect(root.style.transform).toBe('scale(0.5)');
  });

  it('re-measures one frame later when the width is zero', () => {
    const { scaler, root, frames } = setup([0, 576]);
    scaler.refresh();
    expect(root.style.transform).toBeUndefined();
    expect(frames).toHaveLength(1);
    frames[0]();
    expect(root.style.transform).toBe('scale(1)');
  });

  it('gives up after one deferred re-measure that is still zero', () => {
    const { scaler, root, frames } = setup([0, 0]);
    scaler.refresh();
    frames[0]();
    expect(frames).toHaveLength(1);
    expect(root.style.transform).toBeUndefined();
  });

  it('uses the observer when provided and disconnects on dispose', () => {
    const disconnect = vi.fn();
    const root = { style: {} as { transform?: string } };
    let observed: (() => void) | null = null;
    const scaler = attachPreviewScaler({
      measureWidth: () => 384,
      root,
      requestFrame: (cb) => cb(),
      observe: (cb) => {
        observed = cb;
        return disconnect;
      },
    });
    expect(observed).not.toBeNull();
    observed!();
    expect(root.style.transform).toBe(`scale(${384 / 576})`);
    scaler.dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
