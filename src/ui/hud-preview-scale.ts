export const HUD_PREVIEW_WIDTH = 576;

export function computePreviewScale(wrapperWidth: number): number {
  if (!(wrapperWidth > 0)) return 1;
  return Math.min(1, wrapperWidth / HUD_PREVIEW_WIDTH);
}

export type PreviewScalerDeps = {
  measureWidth(): number;
  root: { style: { transform?: string } };
  requestFrame(cb: () => void): void;
  /** Subscribe to size changes; returns an unsubscribe. Omit when ResizeObserver is unavailable. */
  observe?: (cb: () => void) => () => void;
};

export type PreviewScaler = {
  refresh(): void;
  dispose(): void;
};

/**
 * Keeps the 576px HUD root scaled to its wrapper. A hidden wrapper measures 0,
 * so one deferred re-measure covers the frame in which the debug view unhides.
 */
export function attachPreviewScaler(deps: PreviewScalerDeps): PreviewScaler {
  const apply = (width: number) => {
    deps.root.style.transform = `scale(${computePreviewScale(width)})`;
  };

  const refresh = () => {
    const width = deps.measureWidth();
    if (width > 0) {
      apply(width);
      return;
    }
    deps.requestFrame(() => {
      const retry = deps.measureWidth();
      if (retry > 0) apply(retry);
    });
  };

  const unobserve = deps.observe?.(refresh) ?? null;

  return {
    refresh,
    dispose() {
      unobserve?.();
    },
  };
}
