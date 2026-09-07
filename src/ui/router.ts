export type ViewName = 'home' | 'history' | 'diagnostics' | 'debug';

const ROUTES: Record<string, ViewName> = {
  '#/': 'home',
  '#/history': 'history',
  '#/diagnostics': 'diagnostics',
  '#/debug': 'debug',
};

const HASHES: Record<ViewName, string> = {
  home: '#/',
  history: '#/history',
  diagnostics: '#/diagnostics',
  debug: '#/debug',
};

const TITLES: Record<ViewName, string> = {
  home: 'RailGlance',
  history: 'RailGlance – 乗車履歴',
  diagnostics: 'RailGlance – テスター向け診断記録',
  debug: 'RailGlance – 推定状態の詳細',
};

export const VIEW_NAMES: ViewName[] = ['home', 'history', 'diagnostics', 'debug'];

export function resolveRoute(hash: string): ViewName | null {
  return ROUTES[hash] ?? null;
}

export function hashForRoute(route: ViewName): string {
  return HASHES[route];
}

export type ViewElement = {
  hidden: boolean;
  heading: { focus(): void } | null;
};

export type RouterChrome = {
  backButton: { hidden: boolean };
  setTitle(title: string): void;
  scrollToTop(): void;
};

export function applyRoute(
  views: Record<ViewName, ViewElement>,
  route: ViewName,
  chrome: RouterChrome
): void {
  for (const name of VIEW_NAMES) {
    views[name].hidden = name !== route;
  }
  chrome.backButton.hidden = route === 'home';
  chrome.setTitle(TITLES[route]);
  chrome.scrollToTop();
  views[route].heading?.focus();
}

export type RouterDeps = {
  location: { hash: string };
  history: { replaceState(state: unknown, title: string, url: string): void };
  window: { addEventListener(type: 'hashchange', listener: () => void): void };
  views: Record<ViewName, ViewElement>;
  chrome: RouterChrome;
  onRouteApplied?: (route: ViewName) => void;
};

export type Router = {
  start(): void;
  navigate(route: ViewName): void;
};

/**
 * Coordinates location.hash with the visible view. An invalid or empty hash is
 * canonicalised with replaceState (no history entry) and home is applied
 * synchronously, because replaceState never fires hashchange.
 */
export function createRouter(deps: RouterDeps): Router {
  const apply = (route: ViewName) => {
    applyRoute(deps.views, route, deps.chrome);
    deps.onRouteApplied?.(route);
  };

  const sync = () => {
    const route = resolveRoute(deps.location.hash);
    if (route) {
      apply(route);
      return;
    }
    deps.history.replaceState(null, '', HASHES.home);
    apply('home');
  };

  return {
    start() {
      deps.window.addEventListener('hashchange', sync);
      sync();
    },
    navigate(route) {
      deps.location.hash = HASHES[route];
    },
  };
}
