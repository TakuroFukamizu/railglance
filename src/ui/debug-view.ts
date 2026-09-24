import type { ViewName } from './router';

export type DebugViewCoordinatorDeps = {
  panel: { setVisible(visible: boolean): void };
  scaler: { refresh(): void };
};

/** Ties the debug route to the two subsystems that only make sense while it is visible. */
export function createDebugViewCoordinator(deps: DebugViewCoordinatorDeps): {
  onRouteApplied(route: ViewName): void;
} {
  return {
    onRouteApplied(route) {
      const isDebug = route === 'debug';
      deps.panel.setVisible(isDebug);
      if (isDebug) deps.scaler.refresh();
    },
  };
}
