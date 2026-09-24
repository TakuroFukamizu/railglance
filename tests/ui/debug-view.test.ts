import { describe, expect, it, vi } from 'vitest';
import { createDebugViewCoordinator } from '../../src/ui/debug-view';

describe('createDebugViewCoordinator', () => {
  it('shows the panel and refreshes the preview scale on every debug entry', () => {
    const panel = { setVisible: vi.fn() };
    const scaler = { refresh: vi.fn() };
    const coordinator = createDebugViewCoordinator({ panel, scaler });

    coordinator.onRouteApplied('debug');
    coordinator.onRouteApplied('debug');

    expect(panel.setVisible).toHaveBeenNthCalledWith(1, true);
    expect(panel.setVisible).toHaveBeenNthCalledWith(2, true);
    expect(scaler.refresh).toHaveBeenCalledTimes(2);
  });

  it('hides the panel and leaves the scale alone on other routes', () => {
    const panel = { setVisible: vi.fn() };
    const scaler = { refresh: vi.fn() };
    const coordinator = createDebugViewCoordinator({ panel, scaler });

    coordinator.onRouteApplied('home');
    coordinator.onRouteApplied('diagnostics');

    expect(panel.setVisible).toHaveBeenCalledWith(false);
    expect(panel.setVisible).toHaveBeenCalledTimes(2);
    expect(scaler.refresh).not.toHaveBeenCalled();
  });
});
