# Phone UI 再構成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** スマホ側 UI を、ホーム（状態カード + 路線再検出 + 乗車履歴カード）と 3 つの詳細画面（乗車履歴 / 診断記録 / 推定状態の詳細）に再構成する。

**Architecture:** 単一 `index.html` の中に 4 つの `<section data-view>` を置き、`location.hash` で切り替える。表示内容は純粋関数のビルダー（`src/ui/*.ts`）が作り、`main.ts` が DOM に流し込む。DOM に触る部分は最小インターフェースで差し込めるようにし、Node 環境の Vitest で手書きフェイクを使って検証する。

**Tech Stack:** TypeScript, Vite, Vitest (`environment: 'node'`, jsdom なし), vanilla DOM, Even Hub SDK。

**Spec:** `docs/superpowers/specs/2026-09-08-phone-ui-redesign-design.md`

## Global Constraints

- テストは `pnpm test`（Vitest, `environment: 'node'`）。DOM 実装はないので `document` 等は手書きフェイクを差し込む。
- Lint は `pnpm lint`（`--max-warnings=0`）。型チェックは `pnpm build` の `tsc`。
- 診断状態チップ `#diagnostic-indicator` は全画面で常時表示（`docs/TELEMETRY_AND_SENTRY.md`）。
- `index.html` にサンプル路線名・駅名（小田急小田原線、海老名、座間）を書かない。
- `alert()` / `confirm()` を新たに追加しない（既存の「端末内ログを削除」の `confirm` は維持）。
- コミットメッセージは既存に倣い英語 1 行の要約。末尾に次を付ける。

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DZq6fdBeNJdWK8tU8gYiop
```

---

## File Structure

| ファイル | 責務 |
| --- | --- |
| `src/ui/router.ts` | `resolveRoute`、`applyRoute`、`createRouter`。hash → ビュー名、ビュー表示切替、起動/`hashchange` の調停 |
| `src/ui/home-status-card.ts` | `buildHomeStatusView`。HudViewModel + DatasetSyncStatus → 2 行の文言と色クラス |
| `src/ui/route-candidates.ts` | `shouldShowRouteCandidates`、`buildRouteCandidateItems`。候補リストの可否とラベル整形 |
| `src/ui/motion-banner.ts` | `buildMotionBannerView`、`createMotionBannerController`。許可状態 × phase → バナー表示、タイマー付き状態機械 |
| `src/ui/hud-preview-scale.ts` | `computePreviewScale`、`attachPreviewScaler`。576px プレビューの縮小率 |
| `src/ui/debug-view.ts` | `createDebugViewCoordinator`。`debug` ルート進入時の `setVisible` とスケール再計算 |
| `src/ui/debug-panel.ts` | 既存。要素の差し込み、`setVisible`、遅延描画を追加 |
| `src/infrastructure/sensors/device-motion-sensor-fusion-provider.ts` | 既存。`MotionPermissionState` 公開、`insecure-context` / 例外時 `denied`、`onPermissionChange` |
| `index.html` | 共通ヘッダー、4 ビュー、共通診断チップ |
| `src/index.css` | 新レイアウトのスタイル |
| `src/main.ts` | 配線 |

---

### Task 1: ルーター（`resolveRoute` / `applyRoute` / `createRouter`）

**Files:**
- Create: `src/ui/router.ts`
- Test: `tests/ui/router.test.ts`

**Interfaces:**
- Produces:
  - `type ViewName = 'home' | 'history' | 'diagnostics' | 'debug'`
  - `resolveRoute(hash: string): ViewName | null`
  - `type ViewElement = { hidden: boolean; heading: { focus(): void } | null }`
  - `type RouterChrome = { backButton: { hidden: boolean }; setTitle(title: string): void; scrollToTop(): void }`
  - `applyRoute(views: Record<ViewName, ViewElement>, route: ViewName, chrome: RouterChrome): void`
  - `createRouter(deps): { start(): void; navigate(route: ViewName): void }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ui/router.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  applyRoute,
  createRouter,
  resolveRoute,
  type RouterChrome,
  type ViewElement,
  type ViewName,
} from '../../src/ui/router';

function fakeViews(): Record<ViewName, ViewElement & { focused: number }> {
  const make = () => {
    const view = { hidden: true, focused: 0, heading: { focus: () => {} } };
    view.heading.focus = () => {
      view.focused += 1;
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
    const history = { replaceState: vi.fn((_s: unknown, _t: string, url: string) => { location.hash = url; }) };
    const listeners: Array<() => void> = [];
    const window = {
      addEventListener: (_type: 'hashchange', cb: () => void) => listeners.push(cb),
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/ui/router.test.ts`
Expected: FAIL（`../../src/ui/router` が見つからない）

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/router.ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/ui/router.test.ts`
Expected: PASS（12 件）

- [ ] **Step 5: Commit**

```bash
git add src/ui/router.ts tests/ui/router.test.ts
git commit -m "Add a hash router for the phone UI views"
```

---

### Task 2: 現在の乗車カードのビルダー

**Files:**
- Create: `src/ui/home-status-card.ts`
- Test: `tests/ui/home-status-card.test.ts`

**Interfaces:**
- Consumes: `HudViewModel`（`src/domain/models/hud.ts`）、`DatasetSyncStatus`（`src/infrastructure/storage/dexie-railway-database.ts`）
- Produces:
  - `type StatusTone = 'ok' | 'warn' | 'alert'`
  - `type HomeStatusView = { lineName: string; direction: string; speedText: string; statusText: string; tone: StatusTone }`
  - `buildHomeStatusView(model: HudViewModel | null, sync?: DatasetSyncStatus): HomeStatusView`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ui/home-status-card.test.ts
import { describe, expect, it } from 'vitest';
import { buildHomeStatusView } from '../../src/ui/home-status-card';
import type { HudStatusMode, HudViewModel } from '../../src/domain/models/hud';
import type { DatasetSyncStatus } from '../../src/infrastructure/storage/dexie-railway-database';

function model(overrides: Partial<HudViewModel> = {}): HudViewModel {
  return {
    header: { lineName: '小田急小田原線', serviceOrDirection: '上り' },
    speed: { displaySpeedKmhText: '93', unitText: 'km/h', isEstimated: false },
    segment: { previousStationName: '海老名', nextStationName: '座間', progressRatio: 0.4, distanceToNextText: '次まで 4.2km' },
    footer: { leftInfo: '', statusRight: 'GPS' },
    statusMode: 'GPS',
    rawFormattedText: '',
    timestampMs: 0,
    ...overrides,
  };
}

const sync = (partial: Partial<DatasetSyncStatus>): DatasetSyncStatus => ({ status: 'cloud', ...partial });

describe('buildHomeStatusView', () => {
  it('renders the initial placeholder before any model arrives', () => {
    expect(buildHomeStatusView(null)).toEqual({
      lineName: '路線判定中',
      direction: '',
      speedText: '-- km/h',
      statusText: '測位中',
      tone: 'alert',
    });
  });

  it('passes the HUD wording through unchanged', () => {
    const view = buildHomeStatusView(model());
    expect(view.lineName).toBe('小田急小田原線');
    expect(view.direction).toBe('上り');
    expect(view.speedText).toBe('93 km/h');
    expect(view.statusText).toBe('GPS');
    expect(view.tone).toBe('ok');
  });

  it('prefixes an estimated speed with ~', () => {
    const view = buildHomeStatusView(model({ speed: { displaySpeedKmhText: '88', unitText: 'km/h', isEstimated: true } }));
    expect(view.speedText).toBe('~88 km/h');
  });

  it('does not invent blanking: a degraded model keeps its speed text', () => {
    const view = buildHomeStatusView(
      model({ statusMode: 'GPS_DEGRADED', footer: { leftInfo: '', statusRight: 'GPS弱' } })
    );
    expect(view.speedText).toBe('93 km/h');
    expect(view.statusText).toBe('GPS弱');
  });

  it.each<[HudStatusMode, 'ok' | 'warn' | 'alert']>([
    ['GPS', 'ok'],
    ['GPS_DEGRADED', 'warn'],
    ['DR', 'warn'],
    ['REACQUIRING', 'warn'],
    ['UNCERTAIN', 'warn'],
    ['SPEED_UNKNOWN', 'alert'],
    ['LOST', 'alert'],
  ])('maps statusMode %s to tone %s', (statusMode, tone) => {
    expect(buildHomeStatusView(model({ statusMode })).tone).toBe(tone);
  });

  it('appends データ取得中 while downloading', () => {
    expect(buildHomeStatusView(model(), sync({ status: 'downloading' })).statusText).toBe('GPS · データ取得中');
  });

  it.each<DatasetSyncStatus>([
    sync({ status: 'error' }),
    sync({ status: 'unavailable' }),
    sync({ status: 'bundled', errorMessage: 'manifest 404' }),
  ])('appends データ取得エラー for %o', (status) => {
    expect(buildHomeStatusView(model(), status).statusText).toBe('GPS · データ取得エラー');
  });

  it.each<DatasetSyncStatus>([sync({ status: 'bundled' }), sync({ status: 'cached' }), sync({ status: 'cloud' }), sync({ status: 'cloud', errorMessage: '' })])(
    'appends nothing for a healthy %o',
    (status) => {
      expect(buildHomeStatusView(model(), status).statusText).toBe('GPS');
    }
  );

  it('appends the sync suffix to the placeholder as well', () => {
    expect(buildHomeStatusView(null, sync({ status: 'downloading' })).statusText).toBe('測位中 · データ取得中');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/ui/home-status-card.test.ts`
Expected: FAIL（モジュールなし）

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/home-status-card.ts
import type { HudStatusMode, HudViewModel } from '../domain/models/hud';
import type { DatasetSyncStatus } from '../infrastructure/storage/dexie-railway-database';

export type StatusTone = 'ok' | 'warn' | 'alert';

export type HomeStatusView = {
  lineName: string;
  direction: string;
  speedText: string;
  statusText: string;
  tone: StatusTone;
};

const TONE_BY_MODE: Record<HudStatusMode, StatusTone> = {
  GPS: 'ok',
  GPS_DEGRADED: 'warn',
  DR: 'warn',
  REACQUIRING: 'warn',
  UNCERTAIN: 'warn',
  SPEED_UNKNOWN: 'alert',
  LOST: 'alert',
};

function syncSuffix(sync?: DatasetSyncStatus): string {
  if (!sync) return '';
  if (sync.status === 'downloading') return ' · データ取得中';
  if (sync.status === 'error' || sync.status === 'unavailable' || (sync.errorMessage ?? '') !== '') {
    return ' · データ取得エラー';
  }
  return '';
}

/**
 * Home card content. Wording comes straight from the HudViewModel so the phone
 * never disagrees with the glasses; only the tone and the dataset suffix are
 * decided here.
 */
export function buildHomeStatusView(model: HudViewModel | null, sync?: DatasetSyncStatus): HomeStatusView {
  if (!model) {
    return {
      lineName: '路線判定中',
      direction: '',
      speedText: '-- km/h',
      statusText: `測位中${syncSuffix(sync)}`,
      tone: 'alert',
    };
  }
  const prefix = model.speed.isEstimated ? '~' : '';
  return {
    lineName: model.header.lineName,
    direction: model.header.serviceOrDirection,
    speedText: `${prefix}${model.speed.displaySpeedKmhText} ${model.speed.unitText}`,
    statusText: `${model.footer.statusRight}${syncSuffix(sync)}`,
    tone: TONE_BY_MODE[model.statusMode],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/ui/home-status-card.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/home-status-card.ts tests/ui/home-status-card.test.ts
git commit -m "Add the home status card view builder"
```

---

### Task 3: 路線候補のビルダー

**Files:**
- Create: `src/ui/route-candidates.ts`
- Test: `tests/ui/route-candidates.test.ts`

**Interfaces:**
- Consumes: `RouteMatch`, `RouteCandidateScore`（`src/domain/models/railway.ts`）
- Produces:
  - `shouldShowRouteCandidates(match: RouteMatch | null, tieMargin: number): boolean`
  - `type RouteCandidateItem = { segmentId: string; lineName: string; detail: string }`
  - `buildRouteCandidateItems(match: RouteMatch | null): RouteCandidateItem[]`
  - `formatCandidateDistance(meters: number): string`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ui/route-candidates.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildRouteCandidateItems,
  formatCandidateDistance,
  shouldShowRouteCandidates,
} from '../../src/ui/route-candidates';
import type { RouteCandidateScore, RouteMatch } from '../../src/domain/models/railway';

function candidate(lineName: string, segmentId: string, distanceMeters: number): RouteCandidateScore {
  return {
    segment: { id: segmentId } as RouteCandidateScore['segment'],
    line: { id: lineName, name: lineName } as RouteCandidateScore['line'],
    distanceMeters,
    distanceScore: 0,
    headingScore: 0,
    continuityScore: 0,
    historyScore: 0,
    totalScore: 50,
    projectedPoint: [0, 0],
    bearingDegrees: 0,
  };
}

function match(overrides: Partial<RouteMatch>, candidates: RouteCandidateScore[]): RouteMatch {
  return {
    selectedLine: candidates[0]?.line ?? ({ id: 'x', name: 'x' } as RouteMatch['selectedLine']),
    selectedSegment: candidates[0]?.segment ?? ({ id: 'x' } as RouteMatch['selectedSegment']),
    confidence: 0.8,
    candidates,
    timestampMs: 0,
    lockState: 'LOCKED',
    ...overrides,
  };
}

describe('shouldShowRouteCandidates', () => {
  const two = [candidate('A', 'a-1', 100), candidate('B', 'b-1', 200)];

  it('is false without a match or without candidates', () => {
    expect(shouldShowRouteCandidates(null, 15)).toBe(false);
    expect(shouldShowRouteCandidates(match({ lockState: 'UNRESOLVED' }, []), 15)).toBe(false);
  });

  it('is true while reacquiring or unresolved', () => {
    expect(shouldShowRouteCandidates(match({ lockState: 'REACQUIRING' }, two), 15)).toBe(true);
    expect(shouldShowRouteCandidates(match({ lockState: 'UNRESOLVED' }, two), 15)).toBe(true);
  });

  it('is true when locked but the top two are within the tie margin', () => {
    expect(shouldShowRouteCandidates(match({ lockState: 'LOCKED', scoreMargin: 10 }, two), 15)).toBe(true);
  });

  it('is false when locked with a clear margin or a single candidate', () => {
    expect(shouldShowRouteCandidates(match({ lockState: 'LOCKED', scoreMargin: 30 }, two), 15)).toBe(false);
    expect(shouldShowRouteCandidates(match({ lockState: 'LOCKED', scoreMargin: 5 }, [two[0]]), 15)).toBe(false);
  });
});

describe('formatCandidateDistance', () => {
  it('rounds to 10 m below 1 km', () => {
    expect(formatCandidateDistance(123)).toBe('約120m');
    expect(formatCandidateDistance(125)).toBe('約130m');
    expect(formatCandidateDistance(4)).toBe('約0m');
    expect(formatCandidateDistance(999)).toBe('約1000m');
  });

  it('uses one decimal km from 1000 m', () => {
    expect(formatCandidateDistance(1000)).toBe('約1.0km');
    expect(formatCandidateDistance(1249)).toBe('約1.2km');
  });
});

describe('buildRouteCandidateItems', () => {
  it('returns an empty list without a match', () => {
    expect(buildRouteCandidateItems(null)).toEqual([]);
  });

  it('keeps candidate order and strips scores', () => {
    const items = buildRouteCandidateItems(match({}, [candidate('小田急小田原線', 'odk-3', 123), candidate('相鉄本線', 'stt-1', 1400)]));
    expect(items).toEqual([
      { segmentId: 'odk-3', lineName: '小田急小田原線', detail: '約120m' },
      { segmentId: 'stt-1', lineName: '相鉄本線', detail: '約1.4km' },
    ]);
  });

  it('adds the segment id to every member of a duplicate-name group only', () => {
    const items = buildRouteCandidateItems(
      match({}, [candidate('JR東海道線', 'tk-1', 40), candidate('京急本線', 'kq-2', 60), candidate('JR東海道線', 'tk-2', 90)])
    );
    expect(items.map((i) => i.detail)).toEqual(['約40m · tk-1', '約60m', '約90m · tk-2']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/ui/route-candidates.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/route-candidates.ts
import type { RouteMatch } from '../domain/models/railway';

export type RouteCandidateItem = {
  segmentId: string;
  lineName: string;
  detail: string;
};

/** Same predicate main.ts used inline before the redesign. */
export function shouldShowRouteCandidates(match: RouteMatch | null, tieMargin: number): boolean {
  if (!match || match.candidates.length === 0) return false;
  const lockState = match.lockState ?? 'UNRESOLVED';
  if (lockState === 'REACQUIRING' || lockState === 'UNRESOLVED') return true;
  return typeof match.scoreMargin === 'number' && match.scoreMargin < tieMargin && match.candidates.length > 1;
}

export function formatCandidateDistance(meters: number): string {
  if (meters < 1000) return `約${Math.round(meters / 10) * 10}m`;
  return `約${(meters / 1000).toFixed(1)}km`;
}

export function buildRouteCandidateItems(match: RouteMatch | null): RouteCandidateItem[] {
  if (!match) return [];
  const nameCounts = new Map<string, number>();
  for (const c of match.candidates) {
    nameCounts.set(c.line.name, (nameCounts.get(c.line.name) ?? 0) + 1);
  }
  return match.candidates.map((c) => {
    const duplicated = (nameCounts.get(c.line.name) ?? 0) > 1;
    const distance = formatCandidateDistance(c.distanceMeters);
    return {
      segmentId: c.segment.id,
      lineName: c.line.name,
      detail: duplicated ? `${distance} · ${c.segment.id}` : distance,
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/ui/route-candidates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/route-candidates.ts tests/ui/route-candidates.test.ts
git commit -m "Extract the route candidate list builder"
```

---

### Task 4: モーション許可状態の公開と購読

**Files:**
- Modify: `src/infrastructure/sensors/device-motion-sensor-fusion-provider.ts`
- Test: `tests/sensors/device-motion-sensor-fusion-provider.test.ts`（既存に追記）

**Interfaces:**
- Produces:
  - `export type MotionPermissionState = 'unknown' | 'granted' | 'denied' | 'unsupported' | 'insecure-context'`
  - `getPermissionStatus(): MotionPermissionState`（戻り型を `string` から変更）
  - `onPermissionChange(listener: (state: MotionPermissionState) => void): () => void`

- [ ] **Step 1: Write the failing tests（既存ファイル末尾に追記）**

```ts
// tests/sensors/device-motion-sensor-fusion-provider.test.ts に追記
import { afterEach, vi } from 'vitest';

type GlobalWithWindow = typeof globalThis & { window?: unknown; DeviceMotionEvent?: unknown };

function installWindow(options: { secure?: boolean; requestPermission?: (() => Promise<string>) | 'absent' | 'missing-api' }) {
  const g = globalThis as GlobalWithWindow;
  const win: Record<string, unknown> = {
    isSecureContext: options.secure ?? true,
    addEventListener: () => {},
  };
  if (options.requestPermission !== 'missing-api') {
    const DeviceMotionEvent: Record<string, unknown> = {};
    if (typeof options.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission = options.requestPermission;
    }
    win.DeviceMotionEvent = DeviceMotionEvent;
    g.DeviceMotionEvent = DeviceMotionEvent;
  }
  g.window = win;
}

describe('DeviceMotionSensorFusionProvider permission state', () => {
  afterEach(() => {
    const g = globalThis as GlobalWithWindow;
    delete g.window;
    delete g.DeviceMotionEvent;
    vi.useRealTimers();
  });

  it('starts unknown and notifies subscribers on change', async () => {
    installWindow({ requestPermission: async () => 'granted' });
    const provider = new DeviceMotionSensorFusionProvider();
    const seen: string[] = [];
    const unsubscribe = provider.onPermissionChange((s) => seen.push(s));

    expect(provider.getPermissionStatus()).toBe('unknown');
    await expect(provider.requestPermission()).resolves.toBe(true);
    expect(provider.getPermissionStatus()).toBe('granted');
    expect(seen).toEqual(['granted']);

    unsubscribe();
    provider.ingestAccelerationSample(0, 0, 9.8, true, 1000);
    expect(seen).toEqual(['granted']);
  });

  it('reports unsupported when DeviceMotionEvent is missing', async () => {
    installWindow({ requestPermission: 'missing-api' });
    const provider = new DeviceMotionSensorFusionProvider();
    await expect(provider.requestPermission()).resolves.toBe(false);
    expect(provider.getPermissionStatus()).toBe('unsupported');
  });

  it('reports insecure-context before asking the OS', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    installWindow({ secure: false, requestPermission });
    const provider = new DeviceMotionSensorFusionProvider();
    await expect(provider.requestPermission()).resolves.toBe(false);
    expect(provider.getPermissionStatus()).toBe('insecure-context');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('is granted immediately when the platform has no requestPermission API', async () => {
    installWindow({ requestPermission: 'absent' });
    const provider = new DeviceMotionSensorFusionProvider();
    await expect(provider.requestPermission()).resolves.toBe(true);
    expect(provider.getPermissionStatus()).toBe('granted');
  });

  it('reports denied when the OS denies and no event arrives', async () => {
    vi.useFakeTimers();
    installWindow({ requestPermission: async () => 'denied' });
    const provider = new DeviceMotionSensorFusionProvider();
    const pending = provider.requestPermission();
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(false);
    expect(provider.getPermissionStatus()).toBe('denied');
  });

  it('promotes to granted when an event arrives after a denial', async () => {
    vi.useFakeTimers();
    installWindow({ requestPermission: async () => 'denied' });
    const provider = new DeviceMotionSensorFusionProvider();
    const seen: string[] = [];
    provider.onPermissionChange((s) => seen.push(s));
    const pending = provider.requestPermission();
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    provider.ingestAccelerationSample(0, 0, 9.8, true, 1000);
    expect(provider.getPermissionStatus()).toBe('granted');
    expect(seen).toEqual(['denied', 'granted']);
  });

  it('reports denied when requestPermission throws and nothing arrives', async () => {
    vi.useFakeTimers();
    installWindow({ requestPermission: async () => { throw new Error('boom'); } });
    const provider = new DeviceMotionSensorFusionProvider();
    const pending = provider.requestPermission();
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(false);
    expect(provider.getPermissionStatus()).toBe('denied');
  });
});
```

`import { describe, it, expect } from 'vitest';` の行は `import { afterEach, describe, expect, it, vi } from 'vitest';` にまとめる。

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/sensors/device-motion-sensor-fusion-provider.test.ts`
Expected: FAIL（`onPermissionChange` がない、`insecure-context` にならない、例外時に `denied` にならない）

- [ ] **Step 3: Modify the provider**

型と購読を追加し、`permissionStatus` への代入をすべて `setPermissionStatus()` 経由にする。

```ts
// src/infrastructure/sensors/device-motion-sensor-fusion-provider.ts（差分）
export type MotionPermissionState = 'unknown' | 'granted' | 'denied' | 'unsupported' | 'insecure-context';

export class DeviceMotionSensorFusionProvider implements SensorFusionProvider {
  // ...既存フィールド...
  private permissionStatus: MotionPermissionState = 'unknown';
  private permissionListeners: Array<(state: MotionPermissionState) => void> = [];

  private setPermissionStatus(next: MotionPermissionState): void {
    if (this.permissionStatus === next) return;
    this.permissionStatus = next;
    for (const listener of [...this.permissionListeners]) listener(next);
  }

  /** Subscribe to permission changes. Does not replay the current state. */
  public onPermissionChange(listener: (state: MotionPermissionState) => void): () => void {
    this.permissionListeners.push(listener);
    return () => {
      this.permissionListeners = this.permissionListeners.filter((l) => l !== listener);
    };
  }

  public async requestPermission(): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    this.startListening();

    if (!('DeviceMotionEvent' in window)) {
      this.setPermissionStatus('unsupported');
      return false;
    }

    if (window.isSecureContext === false) {
      this.setPermissionStatus('insecure-context');
      return false;
    }

    try {
      const DeviceMotionEventAny = DeviceMotionEvent as any;
      if (typeof DeviceMotionEventAny.requestPermission === 'function') {
        const state = await DeviceMotionEventAny.requestPermission();
        console.log('[SensorFusion] DeviceMotionEvent.requestPermission returned:', state);

        if (state === 'granted') {
          this.setPermissionStatus('granted');
          return true;
        }
        await new Promise((res) => setTimeout(res, 250));
        if (this.hasReceivedEvent) {
          console.log('[SensorFusion] Active devicemotion events received despite permission callback result!');
          this.setPermissionStatus('granted');
          return true;
        }
        this.setPermissionStatus('denied');
        return false;
      }
      this.setPermissionStatus('granted');
      return true;
    } catch (err) {
      console.warn('[SensorFusion] Exception during requestPermission:', err);
      await new Promise((res) => setTimeout(res, 200));
      if (this.hasReceivedEvent) {
        this.setPermissionStatus('granted');
        return true;
      }
      this.setPermissionStatus('denied');
      return false;
    }
  }

  // ingestAccelerationSample 内:
  //   if (this.permissionStatus !== 'granted') { this.permissionStatus = 'granted'; }
  // を
  //   this.setPermissionStatus('granted');
  // に置き換える。

  public getPermissionStatus(): MotionPermissionState {
    return this.permissionStatus;
  }
}
```

`DeviceMotionEvent` はグローバル参照なので、テストでは `globalThis.DeviceMotionEvent` にも同じオブジェクトを置いている（上のテストの `installWindow` 参照）。`startListening()` は `window.addEventListener` を呼ぶだけなのでフェイクの空関数で足りる。

- [ ] **Step 4: Run the sensor tests and the whole suite**

Run: `pnpm vitest run tests/sensors && pnpm vitest run`
Expected: PASS（既存の観測テストも壊れない）

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/sensors/device-motion-sensor-fusion-provider.ts tests/sensors/device-motion-sensor-fusion-provider.test.ts
git commit -m "Expose the motion permission state and its changes"
```

---

### Task 5: モーションバナーのビューとコントローラ

**Files:**
- Create: `src/ui/motion-banner.ts`
- Test: `tests/ui/motion-banner.test.ts`

**Interfaces:**
- Consumes: `MotionPermissionState`（Task 4）
- Produces:
  - `type MotionBannerPhase = 'idle' | 'requesting' | 'just-granted'`
  - `type MotionBannerView = { visible: boolean; message: string; buttonLabel: string | null; buttonDisabled: boolean }`
  - `buildMotionBannerView(state: MotionPermissionState, phase: MotionBannerPhase): MotionBannerView`
  - `createMotionBannerController(deps): { getView(): MotionBannerView; request(): Promise<void>; subscribe(cb): () => void; dispose(): void }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ui/motion-banner.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMotionBannerView,
  createMotionBannerController,
  type MotionBannerView,
} from '../../src/ui/motion-banner';
import type { MotionPermissionState } from '../../src/infrastructure/sensors/device-motion-sensor-fusion-provider';

describe('buildMotionBannerView', () => {
  it('invites the user while unknown', () => {
    const view = buildMotionBannerView('unknown', 'idle');
    expect(view.visible).toBe(true);
    expect(view.message).toContain('トンネル内でも速度を推定');
    expect(view.buttonLabel).toBe('有効化');
    expect(view.buttonDisabled).toBe(false);
  });

  it('disables the button while requesting and keeps the wording', () => {
    expect(buildMotionBannerView('unknown', 'requesting')).toEqual({
      ...buildMotionBannerView('unknown', 'idle'),
      buttonDisabled: true,
    });
    expect(buildMotionBannerView('denied', 'requesting').buttonDisabled).toBe(true);
  });

  it('hides when granted at idle and confirms when just granted', () => {
    expect(buildMotionBannerView('granted', 'idle').visible).toBe(false);
    const view = buildMotionBannerView('granted', 'just-granted');
    expect(view.visible).toBe(true);
    expect(view.message).toBe('有効化しました');
    expect(view.buttonLabel).toBeNull();
  });

  it('offers a retry when denied', () => {
    const view = buildMotionBannerView('denied', 'idle');
    expect(view.visible).toBe(true);
    expect(view.message).toContain('許可されませんでした');
    expect(view.buttonLabel).toBe('再試行');
  });

  it.each<[MotionPermissionState, string]>([
    ['unsupported', 'この端末ではモーションセンサーを利用できません'],
    ['insecure-context', '安全な接続（https）でないためモーションセンサーを利用できません'],
  ])('explains %s without a button', (state, message) => {
    const view = buildMotionBannerView(state, 'idle');
    expect(view.visible).toBe(true);
    expect(view.message).toBe(message);
    expect(view.buttonLabel).toBeNull();
  });
});

describe('createMotionBannerController', () => {
  type FakeProvider = {
    state: MotionPermissionState;
    listeners: Array<(s: MotionPermissionState) => void>;
    getPermissionStatus(): MotionPermissionState;
    onPermissionChange(cb: (s: MotionPermissionState) => void): () => void;
    requestPermission: () => Promise<boolean>;
    set(next: MotionPermissionState): void;
  };

  function fakeProvider(initial: MotionPermissionState, result: MotionPermissionState): FakeProvider {
    const provider: FakeProvider = {
      state: initial,
      listeners: [],
      getPermissionStatus: () => provider.state,
      onPermissionChange(cb) {
        provider.listeners.push(cb);
        return () => {
          provider.listeners = provider.listeners.filter((l) => l !== cb);
        };
      },
      requestPermission: async () => {
        provider.set(result);
        return result === 'granted';
      },
      set(next) {
        provider.state = next;
        provider.listeners.forEach((l) => l(next));
      },
    };
    return provider;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is hidden from the start when already granted', () => {
    const controller = createMotionBannerController({ provider: fakeProvider('granted', 'granted') });
    expect(controller.getView().visible).toBe(false);
  });

  it('shows the confirmation for three seconds after a grant, then hides', async () => {
    const controller = createMotionBannerController({ provider: fakeProvider('unknown', 'granted') });
    const views: MotionBannerView[] = [];
    controller.subscribe((v) => views.push(v));

    const pending = controller.request();
    expect(controller.getView().buttonDisabled).toBe(true);
    await pending;
    expect(controller.getView()).toMatchObject({ visible: true, message: '有効化しました' });

    vi.advanceTimersByTime(2999);
    expect(controller.getView().visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controller.getView().visible).toBe(false);
    expect(views.at(-1)?.visible).toBe(false);
  });

  it('returns to idle with the denial wording when denied', async () => {
    const controller = createMotionBannerController({ provider: fakeProvider('unknown', 'denied') });
    await controller.request();
    expect(controller.getView()).toMatchObject({ visible: true, buttonLabel: '再試行', buttonDisabled: false });
  });

  it('restarts the timer when granted again during the confirmation', async () => {
    const provider = fakeProvider('unknown', 'granted');
    const controller = createMotionBannerController({ provider });
    await controller.request();
    vi.advanceTimersByTime(2000);
    provider.state = 'unknown';
    await controller.request();
    vi.advanceTimersByTime(2000);
    expect(controller.getView().visible).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(controller.getView().visible).toBe(false);
  });

  it('reflects a late promotion to granted from the provider', () => {
    const provider = fakeProvider('denied', 'denied');
    const controller = createMotionBannerController({ provider });
    expect(controller.getView().visible).toBe(true);
    provider.set('granted');
    expect(controller.getView().visible).toBe(false);
  });

  it('dispose unsubscribes and clears the timer', async () => {
    const provider = fakeProvider('unknown', 'granted');
    const controller = createMotionBannerController({ provider });
    await controller.request();
    controller.dispose();
    expect(provider.listeners).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/ui/motion-banner.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/motion-banner.ts
import type { MotionPermissionState } from '../infrastructure/sensors/device-motion-sensor-fusion-provider';

export type MotionBannerPhase = 'idle' | 'requesting' | 'just-granted';

export type MotionBannerView = {
  visible: boolean;
  message: string;
  buttonLabel: string | null;
  buttonDisabled: boolean;
};

const HIDDEN: MotionBannerView = { visible: false, message: '', buttonLabel: null, buttonDisabled: false };

export const JUST_GRANTED_VISIBLE_MS = 3000;

export function buildMotionBannerView(state: MotionPermissionState, phase: MotionBannerPhase): MotionBannerView {
  const requesting = phase === 'requesting';
  switch (state) {
    case 'granted':
      if (phase === 'just-granted') {
        return { visible: true, message: '有効化しました', buttonLabel: null, buttonDisabled: false };
      }
      return HIDDEN;
    case 'denied':
      return {
        visible: true,
        message: '許可されませんでした。端末の設定で Even App のモーションアクセスを許可してください',
        buttonLabel: '再試行',
        buttonDisabled: requesting,
      };
    case 'unsupported':
      return { visible: true, message: 'この端末ではモーションセンサーを利用できません', buttonLabel: null, buttonDisabled: false };
    case 'insecure-context':
      return {
        visible: true,
        message: '安全な接続（https）でないためモーションセンサーを利用できません',
        buttonLabel: null,
        buttonDisabled: false,
      };
    case 'unknown':
    default:
      return {
        visible: true,
        message: 'モーションセンサーを有効にすると、トンネル内でも速度を推定できます',
        buttonLabel: '有効化',
        buttonDisabled: requesting,
      };
  }
}

export type MotionPermissionSource = {
  getPermissionStatus(): MotionPermissionState;
  onPermissionChange(listener: (state: MotionPermissionState) => void): () => void;
  requestPermission(): Promise<boolean>;
};

export type MotionBannerControllerDeps = {
  provider: MotionPermissionSource;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export type MotionBannerController = {
  getView(): MotionBannerView;
  request(): Promise<void>;
  subscribe(listener: (view: MotionBannerView) => void): () => void;
  dispose(): void;
};

/**
 * Small state machine behind the home banner: permission state comes from the
 * provider, the phase (idle / requesting / just-granted) lives here.
 */
export function createMotionBannerController(deps: MotionBannerControllerDeps): MotionBannerController {
  const schedule = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let phase: MotionBannerPhase = 'idle';
  let timer: unknown = null;
  let listeners: Array<(view: MotionBannerView) => void> = [];

  const view = () => buildMotionBannerView(deps.provider.getPermissionStatus(), phase);
  const emit = () => {
    const v = view();
    for (const l of [...listeners]) l(v);
  };
  const clearTimer = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };
  const setPhase = (next: MotionBannerPhase) => {
    phase = next;
    emit();
  };

  const unsubscribeProvider = deps.provider.onPermissionChange(() => emit());

  return {
    getView: view,
    async request() {
      clearTimer();
      setPhase('requesting');
      let granted = false;
      try {
        granted = await deps.provider.requestPermission();
      } catch {
        granted = false;
      }
      if (!granted) {
        setPhase('idle');
        return;
      }
      setPhase('just-granted');
      timer = schedule(() => {
        timer = null;
        setPhase('idle');
      }, JUST_GRANTED_VISIBLE_MS);
    },
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    dispose() {
      clearTimer();
      unsubscribeProvider();
      listeners = [];
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/ui/motion-banner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/motion-banner.ts tests/ui/motion-banner.test.ts
git commit -m "Add the motion sensor banner view and controller"
```

---

### Task 6: HUD プレビューの縮小率

**Files:**
- Create: `src/ui/hud-preview-scale.ts`
- Test: `tests/ui/hud-preview-scale.test.ts`

**Interfaces:**
- Produces:
  - `HUD_PREVIEW_WIDTH = 576`
  - `computePreviewScale(wrapperWidth: number): number`
  - `type PreviewScaler = { refresh(): void; dispose(): void }`
  - `attachPreviewScaler(deps): PreviewScaler`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ui/hud-preview-scale.test.ts
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
    const wrapper = { widths, style: {} as Record<string, string> };
    const root = { style: {} as Record<string, string> };
    const frames: Array<() => void> = [];
    const scaler = attachPreviewScaler({
      measureWidth: () => wrapper.widths.shift() ?? 0,
      root,
      requestFrame: (cb) => frames.push(cb),
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
    const root = { style: {} as Record<string, string> };
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/ui/hud-preview-scale.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/hud-preview-scale.ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/ui/hud-preview-scale.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/hud-preview-scale.ts tests/ui/hud-preview-scale.test.ts
git commit -m "Scale the HUD preview to its wrapper width"
```

---

### Task 7: DebugPanel の遅延描画

**Files:**
- Modify: `src/ui/debug-panel.ts:32-48`（コンストラクタ）と `:221`（`this.container.innerHTML = html`）
- Test: `tests/ui/debug-panel.test.ts`（既存に追記）

**Interfaces:**
- Produces:
  - `type DebugPanelContainer = { innerHTML: string }`
  - `new DebugPanel(target: string | DebugPanelContainer)`
  - `setVisible(visible: boolean): void`
  - `update(...)` は非表示中は描画せず保留する

- [ ] **Step 1: Write the failing tests（既存ファイル末尾に追記）**

```ts
// tests/ui/debug-panel.test.ts に追記
describe('DebugPanel deferred rendering', () => {
  function countingContainer() {
    const container = { writes: 0, _html: '' };
    Object.defineProperty(container, 'innerHTML', {
      get: () => container._html,
      set: (v: string) => {
        container._html = v;
        container.writes += 1;
      },
    });
    return container as { innerHTML: string; writes: number };
  }

  it('does not write while hidden and renders the latest args once when shown', () => {
    const container = countingContainer();
    const panel = new DebugPanel(container);

    panel.update(estimationEntry(), 'first');
    panel.update(estimationEntry(), 'second');
    expect(container.writes).toBe(0);

    panel.setVisible(true);
    expect(container.writes).toBe(1);
    expect(container.innerHTML).toContain('second');
    expect(container.innerHTML).not.toContain('first');
  });

  it('does not re-render on a repeated setVisible(true) without new data', () => {
    const container = countingContainer();
    const panel = new DebugPanel(container);
    panel.update(estimationEntry(), 'x');
    panel.setVisible(true);
    panel.setVisible(true);
    expect(container.writes).toBe(1);
  });

  it('renders immediately while visible', () => {
    const container = countingContainer();
    const panel = new DebugPanel(container);
    panel.setVisible(true);
    expect(container.writes).toBe(0);
    panel.update(estimationEntry(), 'live');
    expect(container.writes).toBe(1);
  });

  it('hiding never writes; showing again after new data writes once', () => {
    const container = countingContainer();
    const panel = new DebugPanel(container);
    panel.setVisible(true);
    panel.update(estimationEntry(), 'a');
    panel.setVisible(false);
    expect(container.writes).toBe(1);
    panel.update(estimationEntry(), 'b');
    panel.setVisible(true);
    expect(container.writes).toBe(2);
    expect(container.innerHTML).toContain('b');
  });
});
```

既存の 2 テスト（`DebugPanel Even G2 Bridge Transport card`）は `new DebugPanel('debug-panel')` の直後に `update` を呼んで描画を期待しているので、それぞれ `panel.update(...)` の前に `panel.setVisible(true);` を 1 行足す。

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/ui/debug-panel.test.ts`
Expected: FAIL（`setVisible` がない、要素を受け取れない）

- [ ] **Step 3: Modify DebugPanel**

```ts
// src/ui/debug-panel.ts（差分）
export type DebugPanelContainer = { innerHTML: string };

type DebugPanelArgs = [
  entry: EstimationLogEntry,
  lastImageResult?: string,
  datasetSyncStatus?: DatasetSyncStatus,
  bridge?: BridgeDiagnosticsSnapshot,
];

export class DebugPanel {
  private container: DebugPanelContainer;
  private visible = false;
  private dirty = false;
  private latestArgs: DebugPanelArgs | null = null;

  constructor(target: string | DebugPanelContainer) {
    if (typeof target !== 'string') {
      this.container = target;
      return;
    }
    const el = document.getElementById(target);
    if (!el) {
      const created = document.createElement('div');
      created.id = target;
      document.body.appendChild(created);
      this.container = created;
    } else {
      this.container = el;
    }
  }

  /** Rendering is deferred while hidden; showing flushes the latest update once. */
  public setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.dirty && this.latestArgs) {
      this.render(...this.latestArgs);
    }
  }

  public update(
    entry: EstimationLogEntry,
    lastImageResult?: string,
    datasetSyncStatus?: DatasetSyncStatus,
    bridge?: BridgeDiagnosticsSnapshot
  ): void {
    this.latestArgs = [entry, lastImageResult, datasetSyncStatus, bridge];
    if (!this.visible) {
      this.dirty = true;
      return;
    }
    this.render(entry, lastImageResult, datasetSyncStatus, bridge);
  }

  private render(
    entry: EstimationLogEntry,
    lastImageResult?: string,
    datasetSyncStatus?: DatasetSyncStatus,
    bridge?: BridgeDiagnosticsSnapshot
  ): void {
    this.dirty = false;
    // ...既存の update() 本体をここへ移す（const { rawLocation, ... } から this.container.innerHTML = html; まで）...
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/ui/debug-panel.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/debug-panel.ts tests/ui/debug-panel.test.ts
git commit -m "Defer DebugPanel rendering while the debug view is hidden"
```

---

### Task 8: debug ビューの調停役

**Files:**
- Create: `src/ui/debug-view.ts`
- Test: `tests/ui/debug-view.test.ts`

**Interfaces:**
- Consumes: `ViewName`（Task 1）、`PreviewScaler`（Task 6）、`DebugPanel.setVisible`（Task 7）
- Produces: `createDebugViewCoordinator(deps: { panel: { setVisible(v: boolean): void }; scaler: { refresh(): void } }): { onRouteApplied(route: ViewName): void }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ui/debug-view.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/ui/debug-view.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```ts
// src/ui/debug-view.ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/ui/debug-view.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/debug-view.ts tests/ui/debug-view.test.ts
git commit -m "Coordinate the debug view with the panel and preview scale"
```

---

### Task 9: `index.html` と CSS の再構成

**Files:**
- Modify: `index.html`（全体を置き換え）
- Modify: `src/index.css`

このタスクは単体テストがなく、`pnpm build` と手動確認で検証する。`main.ts` は Task 10 で追随するので、このタスク直後は要素 ID の不一致で一部の配線が動かない（`pnpm build` は通る）。

- [ ] **Step 1: Replace `index.html`**

```html
<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>RailGlance</title>
  </head>
  <body>
    <div id="app">
      <header class="app-header">
        <button id="btn-back" class="btn-back" type="button" hidden aria-label="ホームに戻る">‹ 戻る</button>
        <div class="app-identity">
          <h1>RailGlance</h1>
          <p id="build-info" class="build-info">バージョン情報を読み込み中…</p>
        </div>
      </header>

      <main class="app-main">
        <!-- ホーム -->
        <section data-view="home" class="view" hidden>
          <h2 class="visually-hidden" tabindex="-1">ホーム</h2>

          <aside id="motion-banner" class="motion-banner" hidden>
            <span id="motion-banner-message"></span>
            <button id="btn-motion-banner" class="btn btn-secondary" type="button">有効化</button>
          </aside>

          <section class="card status-card" aria-label="現在の乗車">
            <div class="status-row status-row-primary">
              <span id="status-line-name" class="status-line-name">路線判定中</span>
              <span id="status-direction" class="status-direction"></span>
            </div>
            <div class="status-row status-row-secondary">
              <span id="status-speed" class="status-speed">-- km/h</span>
              <span id="status-right" class="status-right status-alert">測位中</span>
            </div>
          </section>

          <div class="route-control-actions">
            <button id="btn-reacquire-route" class="btn btn-secondary" type="button">路線を再検出</button>
            <button id="btn-unlock-route" class="btn" type="button" hidden>自動判定に戻す</button>
          </div>
          <p id="route-lock-warning" class="route-lock-warning" hidden>選択した路線から離れています</p>
          <div id="route-candidates" class="route-candidates" hidden>
            <h3>路線候補</h3>
            <ul id="route-candidate-list"></ul>
          </div>

          <section class="card history-card" aria-labelledby="history-card-title">
            <div class="card-heading">
              <h3 id="history-card-title">乗車履歴</h3>
              <a href="#/history" class="card-link">すべて ›</a>
            </div>
            <div id="history-card-body" class="card-empty">乗車履歴はまもなく利用できるようになります</div>
          </section>

          <nav class="secondary-links" aria-label="その他">
            <a href="#/diagnostics">テスター向け診断記録 ›</a>
            <a href="#/debug">推定状態の詳細 ›</a>
          </nav>
        </section>

        <!-- 乗車履歴 -->
        <section data-view="history" class="view" hidden>
          <h2 tabindex="-1">乗車履歴</h2>
          <p class="card-empty">乗車履歴はまもなく利用できるようになります</p>
        </section>

        <!-- テスター向け診断記録 -->
        <section data-view="diagnostics" class="view diagnostic-section" hidden>
          <h2 tabindex="-1">テスター向け診断記録</h2>
          <p>
            通常はエラーと、位置座標を除いた状態変化だけを Sentry に送信します。
            キャンペーン参加中は正確な GPS 座標、速度、路線・区間・駅の判定、デッドレコニング状態を
            障害解析のため Cloudflare R2 に送信します。参加コードは初回だけ入力し、資格期間中は起動時に
            自動再開・再送します。
          </p>
          <label class="diagnostic-consent">
            <input id="diagnostic-consent" type="checkbox" />
            上記の収集内容と、管理者が設定した保持期間中の保存に同意します
          </label>
          <div class="diagnostic-controls">
            <label for="diagnostic-access-code">初回参加コード</label>
            <input
              id="diagnostic-access-code"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="キャンペーン参加時のみ"
            />
            <button id="btn-diagnostic-start" class="btn btn-secondary" type="button">参加して診断収集を開始</button>
            <button id="btn-diagnostic-stop" class="btn" type="button" disabled>診断収集を停止</button>
            <button id="btn-diagnostic-delete" class="btn btn-danger" type="button">端末内ログを削除</button>
          </div>
        </section>

        <!-- 推定状態の詳細 -->
        <section data-view="debug" class="view" hidden>
          <h2 tabindex="-1">推定状態の詳細</h2>

          <section class="preview-section">
            <h3>Even G2 HUD プレビュー（576×288 を縮小表示）</h3>
            <div id="hud-preview-wrapper" class="glasses-viewport">
              <div id="hud-root" class="hud-root">
                <div class="hud-header">
                  <span id="hud-line-name" class="hud-line-name brightness-secondary"></span>
                  <span id="hud-service" class="hud-service brightness-secondary"></span>
                </div>
                <div class="hud-speed-container">
                  <span id="hud-speed-val" class="speed-value brightness-primary">--</span>
                  <span class="speed-unit brightness-tertiary">km/h</span>
                  <span id="hud-speed-est" class="speed-estimated brightness-tertiary">~</span>
                </div>
                <div class="hud-segment-container">
                  <div class="hud-station-row">
                    <span id="hud-prev-station" class="station-prev brightness-secondary"></span>
                    <span id="hud-progress-text" class="progress-text brightness-secondary">━━━━━━━━━</span>
                    <span id="hud-next-station" class="station-next brightness-primary"></span>
                  </div>
                </div>
                <div class="hud-footer">
                  <span id="hud-dist-next" class="footer-left brightness-tertiary"></span>
                  <span id="hud-footer-right" class="footer-right brightness-tertiary"></span>
                </div>
              </div>
            </div>
            <div id="hud-preview-controls" class="hud-preview-controls"></div>
          </section>

          <section class="debug-section">
            <h3>位置ソース</h3>
            <div class="controls">
              <button id="btn-start" class="btn btn-primary" type="button">実機GPS開始</button>
              <button id="btn-stop" class="btn" type="button">停止</button>
              <button id="btn-replay-odakyu" class="btn btn-secondary" type="button">小田急線デモ</button>
              <button id="btn-replay-shinkansen" class="btn btn-secondary" type="button">新幹線デモ</button>
            </div>
          </section>

          <section class="debug-section">
            <h3>マルチソース速度推定 & NavigationState デバッグパネル</h3>
            <div id="debug-panel"></div>
          </section>
        </section>
      </main>

      <button id="diagnostic-indicator" class="diagnostic-indicator" type="button" aria-live="polite">
        <strong id="diagnostic-status">診断収集: 停止</strong>
        <span id="diagnostic-detail">通常のエラー収集のみ有効です。</span>
      </button>
    </div>

    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Update `src/index.css`**

以下を変更する。既存のデバッグ系スタイル（`.debug-*`、`.badge.*`、`.candidate-table`、HUD の `.hud-*` / `.speed-*` / `.station-*` / `.brightness-*`）と診断フォーム（`.diagnostic-consent`、`.diagnostic-controls`）は維持する。

1. `body` の下パディングと `[hidden]`:

```css
:root {
  /* ...既存... */
  --chip-reserve: 112px; /* 参加済みの最長 detail が 320px 幅で 3 行に折り返した高さ + 余白 */
}

body {
  /* ...既存... */
  padding-bottom: calc(var(--chip-reserve) + env(safe-area-inset-bottom));
}

[hidden] {
  display: none !important;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.view > h2 {
  font-size: 20px;
  margin-bottom: 16px;
}

.view > h2:focus {
  outline: none;
}
```

2. ヘッダーと戻るボタン（既存 `.app-header` を置き換え）:

```css
.app-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 12px;
}

.btn-back {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-color);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 15px;
  cursor: pointer;
}
```

3. カードとホーム要素:

```css
.card {
  margin-top: 16px;
  background-color: var(--panel-bg);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 18px 20px;
}

.status-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}

.status-line-name {
  font-size: 22px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-direction {
  font-size: 18px;
  font-weight: 600;
  color: #8b949e;
  flex-shrink: 0;
}

.status-row-secondary {
  margin-top: 10px;
}

.status-speed {
  font-size: 34px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.status-right {
  font-size: 15px;
  font-weight: 600;
  text-align: right;
}

.status-ok { color: #3fb950; }
.status-warn { color: #d29922; }
.status-alert { color: #f85149; }

.card-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.card-heading h3 {
  font-size: 18px;
  font-weight: 700;
}

.card-link {
  color: #58a6ff;
  text-decoration: none;
  font-size: 15px;
}

.card-empty {
  margin-top: 10px;
  color: #8b949e;
  line-height: 1.6;
}

.secondary-links {
  display: grid;
  gap: 6px;
  margin-top: 20px;
}

.secondary-links a {
  color: #8b949e;
  text-decoration: none;
  padding: 8px 4px;
  font-size: 15px;
}

.motion-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid #9e6a03;
  background: rgba(210, 153, 34, 0.12);
  color: #e3b341;
  border-radius: 8px;
  line-height: 1.5;
}
```

4. 路線再検出（既存 `.route-control-section` は削除し、`.route-control-actions` の `margin-top` を 12px のまま維持。候補ボタンのスタイルは維持）。

5. 診断チップ（既存 `.diagnostic-indicator` を置き換え）:

```css
.diagnostic-indicator {
  position: fixed;
  right: 16px;
  bottom: calc(16px + env(safe-area-inset-bottom));
  left: 16px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 10px 12px;
  text-align: left;
  font: inherit;
  color: #8c959f;
  background: rgba(13, 17, 23, 0.96);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  cursor: pointer;
}
```

`.diagnostic-indicator.is-active` / `.is-error` は維持。`.diagnostic-section` の `margin-top` と背景は維持し、`> p` の余白も維持。

6. プレビュー（既存 `.glasses-viewport` と `.hud-root` を置き換え、`@media` 内の `.preview-section { overflow-x: auto }` を削除）:

```css
.preview-section h3 {
  font-size: 14px;
  margin-bottom: 10px;
  color: #8b949e;
}

.glasses-viewport {
  position: relative;
  width: min(100%, 576px);
  aspect-ratio: 2 / 1;
  margin: 0 auto 16px;
  background-color: #000000;
  border: 2px solid #333;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 0 20px rgba(0, 255, 0, 0.15);
}

.hud-root {
  position: absolute;
  top: 0;
  left: 0;
  width: 576px;
  height: 288px;
  transform-origin: top left;
  background-color: #000000;
  overflow: hidden;
  font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, monospace;
}

.hud-preview-controls {
  min-height: 0;
}
```

7. モバイル `@media (max-width: 720px)`:

```css
@media (max-width: 720px) {
  body {
    padding: 12px;
    padding-bottom: calc(var(--chip-reserve) + env(safe-area-inset-bottom));
  }

  .diagnostic-indicator {
    right: 8px;
    bottom: calc(8px + env(safe-area-inset-bottom));
    left: 8px;
  }
}
```

- [ ] **Step 3: Type-check and build**

Run: `pnpm build`
Expected: 成功（`main.ts` は古い ID を `?.` で引いているので型エラーは出ない）

- [ ] **Step 4: Commit**

```bash
git add index.html src/index.css
git commit -m "Restructure the phone UI into home and detail views"
```

---

### Task 10: `main.ts` の配線

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: Task 1〜8 のすべて

- [ ] **Step 1: Rewrite the wiring in `src/main.ts`**

`DemoGpsReplayerProvider`、デモ座標、`updateViewportDOM`、`renderBuildInfo` は変更しない。`init()` を次のように書き換える（診断フォームのハンドラは既存のまま）。

```ts
// 追加 import
import { createRouter, VIEW_NAMES, type ViewName, type ViewElement } from './ui/router';
import { buildHomeStatusView, type StatusTone } from './ui/home-status-card';
import { buildRouteCandidateItems, shouldShowRouteCandidates } from './ui/route-candidates';
import { createMotionBannerController } from './ui/motion-banner';
import { attachPreviewScaler } from './ui/hud-preview-scale';
import { createDebugViewCoordinator } from './ui/debug-view';

function renderHomeStatus(model: HudViewModel | null, sync?: DatasetSyncStatus): void {
  const view = buildHomeStatusView(model, sync);
  const lineName = document.getElementById('status-line-name');
  const direction = document.getElementById('status-direction');
  const speed = document.getElementById('status-speed');
  const right = document.getElementById('status-right');
  if (lineName) lineName.textContent = view.lineName;
  if (direction) direction.textContent = view.direction;
  if (speed) speed.textContent = view.speedText;
  if (right) {
    right.textContent = view.statusText;
    const tones: StatusTone[] = ['ok', 'warn', 'alert'];
    for (const tone of tones) right.classList.toggle(`status-${tone}`, tone === view.tone);
  }
}

async function init() {
  renderBuildInfo();

  const debugPanel = new DebugPanel('debug-panel');
  const motionSensorProvider = new DeviceMotionSensorFusionProvider();

  let latestModel: HudViewModel | null = null;
  const { controller, db, evenG2Adapter, logger, telemetryManager } = await bootstrapApp(undefined, (_formattedText, model) => {
    if (model) {
      latestModel = model;
      updateViewportDOM(model);
      renderHomeStatus(model, db.getSyncStatus?.());
    }
  });

  // --- ルーター ---
  const views = Object.fromEntries(
    VIEW_NAMES.map((name) => {
      const section = document.querySelector<HTMLElement>(`[data-view="${name}"]`)!;
      const heading = section.querySelector<HTMLElement>('h2');
      const element: ViewElement = {
        get hidden() {
          return section.hidden;
        },
        set hidden(value: boolean) {
          section.hidden = value;
        },
        heading: heading ? { focus: () => heading.focus({ preventScroll: true }) } : null,
      };
      return [name, element];
    })
  ) as Record<ViewName, ViewElement>;

  const backButton = document.getElementById('btn-back') as HTMLButtonElement;
  const hudRoot = document.getElementById('hud-root') as HTMLElement;
  const previewWrapper = document.getElementById('hud-preview-wrapper') as HTMLElement;
  const scaler = attachPreviewScaler({
    measureWidth: () => previewWrapper.clientWidth,
    root: hudRoot,
    requestFrame: (cb) => requestAnimationFrame(cb),
    observe:
      typeof ResizeObserver === 'function'
        ? (cb) => {
            const observer = new ResizeObserver(() => cb());
            observer.observe(previewWrapper);
            return () => observer.disconnect();
          }
        : undefined,
  });
  const debugView = createDebugViewCoordinator({ panel: debugPanel, scaler });

  const router = createRouter({
    location: window.location,
    history: window.history,
    window,
    views,
    chrome: {
      backButton,
      setTitle: (title) => {
        document.title = title;
      },
      scrollToTop: () => window.scrollTo(0, 0),
    },
    onRouteApplied: (route) => debugView.onRouteApplied(route),
  });
  backButton.addEventListener('click', () => router.navigate('home'));
  document.getElementById('diagnostic-indicator')?.addEventListener('click', () => router.navigate('diagnostics'));
  router.start();

  // --- 路線再検出 ---
  const routeCandidateList = document.getElementById('route-candidate-list');
  const routeCandidates = document.getElementById('route-candidates');
  const unlockRouteButton = document.getElementById('btn-unlock-route') as HTMLButtonElement | null;
  const routeLockWarning = document.getElementById('route-lock-warning');

  const renderRouteControls = () => {
    const match = controller.getCurrentRouteMatch();
    const lockState = match?.lockState ?? 'UNRESOLVED';
    if (unlockRouteButton) unlockRouteButton.hidden = lockState !== 'MANUAL_LOCK';
    if (routeLockWarning) routeLockWarning.hidden = !(lockState === 'MANUAL_LOCK' && match?.manualLockAway);

    const show = shouldShowRouteCandidates(match, DEFAULT_TRACKING_CONFIG.routeCandidateTieMargin);
    if (routeCandidates) routeCandidates.hidden = !show;
    if (routeCandidateList) {
      routeCandidateList.replaceChildren();
      for (const item of buildRouteCandidateItems(match)) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'route-candidate-button';
        button.dataset.segmentId = item.segmentId;
        const name = document.createElement('strong');
        name.textContent = item.lineName;
        const detail = document.createElement('small');
        detail.textContent = item.detail;
        button.append(name, detail);
        li.append(button);
        routeCandidateList.append(li);
      }
    }
  };

  logger.subscribe((entry) => {
    const lastImageResult = evenG2Adapter.getLastImageResult ? evenG2Adapter.getLastImageResult() : 'none';
    const syncStatus = db.getSyncStatus ? db.getSyncStatus() : undefined;
    const bridge = evenG2Adapter.getBridgeDiagnostics?.();
    debugPanel.update(entry, lastImageResult, syncStatus, bridge);
    renderRouteControls();
    renderHomeStatus(latestModel, syncStatus);
  });

  // btn-reacquire-route / btn-unlock-route / route-candidate-list のクリックハンドラは既存のまま。
  // btn-start / btn-stop / btn-replay-* のハンドラも既存のまま。

  // --- モーションバナー ---
  const motionBanner = document.getElementById('motion-banner') as HTMLElement | null;
  const motionBannerMessage = document.getElementById('motion-banner-message');
  const motionBannerButton = document.getElementById('btn-motion-banner') as HTMLButtonElement | null;
  const motionController = createMotionBannerController({ provider: motionSensorProvider });
  const renderMotionBanner = () => {
    const view = motionController.getView();
    if (motionBanner) motionBanner.hidden = !view.visible;
    if (motionBannerMessage) motionBannerMessage.textContent = view.message;
    if (motionBannerButton) {
      motionBannerButton.hidden = view.buttonLabel === null;
      motionBannerButton.textContent = view.buttonLabel ?? '';
      motionBannerButton.disabled = view.buttonDisabled;
    }
  };
  motionController.subscribe(renderMotionBanner);
  motionBannerButton?.addEventListener('click', () => void motionController.request());
  renderMotionBanner();

  // 旧 btn-request-motion のハンドラ（alert を出すもの）は削除する。

  // --- 診断フォーム（既存のまま） ---
  // diagnosticConsent ... diagnosticDelete のハンドラと renderDiagnosticStatus は変更しない。

  await controller.start();
}
```

`DatasetSyncStatus` の型 import を追加する: `import type { DatasetSyncStatus } from './infrastructure/storage/dexie-railway-database';`

- [ ] **Step 2: Lint, type-check, test**

Run: `pnpm lint && pnpm build && pnpm test`
Expected: すべて成功

- [ ] **Step 3: Manual check in the simulator**

Run: `pnpm dev:web` を起動し、ブラウザ（幅 375px のモバイルエミュレーション）で `http://localhost:5173/` を開く。Playwright（`playwright-skill`）でスクリーンショットを撮って確認してもよい。

確認項目:
- ホームにカード 2 枚、路線再検出ボタン、副次リンク 2 行、下部チップが出る。サンプル路線名が出ない。
- 「推定状態の詳細 ›」で `#/debug` に移り、戻るボタンが出て、プレビューが横スクロールなしで収まる。デバッグパネルはこの画面に入った時点で描画される。
- `#/bogus` を直接開くとホームになり、URL が `#/` に置き換わる。
- `#/debug` でリロードすると `#/debug` のまま。
- 下部チップをタップすると `#/diagnostics` に移る。
- 320px 幅で、診断画面の最後のボタンがチップに隠れずスクロールで到達できる。

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "Wire the phone UI views, home card and motion banner"
```

---

### Task 11: 仕上げ（README 更新、追跡 Issue、PR）

**Files:**
- Modify: `README.md`（「ディレクトリ構成」の `src/ui/` に新モジュールを追記）

- [ ] **Step 1: Update README**

`README.md` のディレクトリ構成の `ui/` 配下に次を追加する。

```text
  ui/
    router.ts                  # hash ルーティング（home / history / diagnostics / debug）
    home-status-card.ts        # ホームの現在の乗車カード
    route-candidates.ts        # 路線候補リストの整形
    motion-banner.ts           # モーションセンサー許可バナー
    hud-preview-scale.ts       # 576×288 プレビューの縮小
    debug-view.ts              # debug ビューと DebugPanel / スケーラの連携
    debug-panel.ts             # 推定状態デバッグパネル（表示中のみ描画）
    diagnostic-panel.ts        # 診断参加状態の表示
```

- [ ] **Step 2: Run the full verification**

Run: `pnpm lint && pnpm build && pnpm test`
Expected: すべて成功

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "Document the phone UI modules"
git push -u origin control-phone-ui-redesign
```

- [ ] **Step 4: Open the follow-up issues and the PR**

`gh issue create` で 2 件:
1. 「乗車履歴の記録・一覧・エクスポート」: ホームの `#history-card-body` と `#/history` ビューが入口。エクスポート手段の WebView での可否確認を含む。
2. 「開発用 HUD プレビューの状態切替と視認性確認モード」: `HUD_UI_UX_REQUIREMENTS.md` 21 章・22 章。置き場は `#hud-preview-controls`。

`gh pr create --base main` で PR を作る。本文には spec へのリンク、画面構成の要約、手動確認の結果、フォローアップ Issue 番号を書き、末尾に次を付ける。

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DZq6fdBeNJdWK8tU8gYiop
```
