import { describe, expect, it, vi } from 'vitest';
import {
  applyRoute,
  createRouter,
  resolveRoute,
  type RouterChrome,
  type ViewElement,
  type ViewName,
} from '../../src/ui/router';

type FakeView = ViewElement & { focused: number };

function fakeViews(): Record<ViewName, FakeView> {
  const make = (): FakeView => {
    const view: FakeView = { hidden: true, focused: 0, heading: null };
    view.heading = {
      focus: () => {
        view.focused += 1;
      },
    };
    return view;
  };
  return { home: make(), history: make(), diagnostics: make(), debug: make() };
}

function fakeChrome(): RouterChrome & { titles: string[]; scrolls: number } {
  const chrome = {
    backButton: { hidden: true },
    titles: [] as string[],
    scrolls: 0,
    setTitle(title: string) {
      chrome.titles.push(title);
    },
    scrollToTop() {
      chrome.scrolls += 1;
    },
  };
  return chrome;
}

describe('resolveRoute', () => {
  it('maps the four known hashes to views', () => {
    expect(resolveRoute('#/')).toBe('home');
    expect(resolveRoute('#/history')).toBe('history');
    expect(resolveRoute('#/diagnostics')).toBe('diagnostics');
    expect(resolveRoute('#/debug')).toBe('debug');
  });

  it('returns null for empty or unknown hashes', () => {
    expect(resolveRoute('')).toBeNull();
    expect(resolveRoute('#')).toBeNull();
    expect(resolveRoute('#/nope')).toBeNull();
    expect(resolveRoute('#/debug/extra')).toBeNull();
  });
});

describe('applyRoute', () => {
  it('shows only the target view, scrolls to top and focuses its heading', () => {
    const views = fakeViews();
    const chrome = fakeChrome();

    applyRoute(views, 'debug', chrome);

    expect(views.debug.hidden).toBe(false);
    expect(views.home.hidden).toBe(true);
    expect(views.history.hidden).toBe(true);
    expect(views.diagnostics.hidden).toBe(true);
    expect(views.debug.focused).toBe(1);
    expect(chrome.scrolls).toBe(1);
    expect(chrome.titles).toEqual(['RailGlance – 推定状態の詳細']);
  });

  it('hides the back button on home and shows it elsewhere', () => {
    const views = fakeViews();
    const chrome = fakeChrome();

    applyRoute(views, 'home', chrome);
    expect(chrome.backButton.hidden).toBe(true);
    expect(chrome.titles.at(-1)).toBe('RailGlance');

    applyRoute(views, 'history', chrome);
    expect(chrome.backButton.hidden).toBe(false);
    expect(chrome.titles.at(-1)).toBe('RailGlance – 乗車履歴');
  });

  it('tolerates a view without a heading', () => {
    const views = fakeViews();
    views.history.heading = null;
    expect(() => applyRoute(views, 'history', fakeChrome())).not.toThrow();
  });
});

describe('createRouter', () => {
  function setup(initialHash: string) {
    const views = fakeViews();
    const chrome = fakeChrome();
    const location = { hash: initialHash };
    const history = {
      replaceState: vi.fn((_state: unknown, _title: string, url: string) => {
        location.hash = url;
      }),
    };
    const listeners: Array<() => void> = [];
    const window = {
      addEventListener: (_type: 'hashchange', cb: () => void) => {
        listeners.push(cb);
      },
    };
    const onRouteApplied = vi.fn();
    const router = createRouter({ location, history, window, views, chrome, onRouteApplied });
    return { router, views, chrome, location, history, listeners, onRouteApplied };
  }

  it('honours a valid hash at startup', () => {
    const { router, views, history, onRouteApplied } = setup('#/debug');
    router.start();
    expect(views.debug.hidden).toBe(false);
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(onRouteApplied).toHaveBeenCalledWith('debug');
  });

  it('replaces an empty hash with #/ and shows home synchronously', () => {
    const { router, views, location, history, onRouteApplied } = setup('');
    router.start();
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe('#/');
    expect(views.home.hidden).toBe(false);
    expect(onRouteApplied).toHaveBeenCalledWith('home');
  });

  it('replaces an unknown hash on hashchange and shows home', () => {
    const { router, views, location, listeners, history } = setup('#/history');
    router.start();
    location.hash = '#/bogus';
    listeners.forEach((cb) => cb());
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe('#/');
    expect(views.home.hidden).toBe(false);
    expect(views.history.hidden).toBe(true);
  });

  it('switches views on hashchange and reports the route', () => {
    const { router, views, location, listeners, onRouteApplied } = setup('#/');
    router.start();
    location.hash = '#/diagnostics';
    listeners.forEach((cb) => cb());
    expect(views.diagnostics.hidden).toBe(false);
    expect(onRouteApplied).toHaveBeenLastCalledWith('diagnostics');
  });

  it('navigate() sets the hash', () => {
    const { router, location } = setup('#/');
    router.start();
    router.navigate('history');
    expect(location.hash).toBe('#/history');
  });
});
