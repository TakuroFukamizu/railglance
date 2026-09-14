import { describe, expect, it } from 'vitest';
import { FixtureRailwayDb, loadTokyoCoreFixture } from './fixture-db';
import { runScenario, ScenarioResult } from './runner';
import { EDGE_SCENARIOS, EdgeScenario } from './scenarios';
import { generateTrace } from './trace';

type HardCheck = 'no-forbidden-line' | 'correct-final-line' | 'no-wrong-line';

/**
 * Hard expectations the current MapMatcher does not meet yet (dataset v1.4.0,
 * DEFAULT_TRACKING_CONFIG). They run as it.fails, so a logic change that fixes
 * one turns that test red: delete the entry and re-record the baseline with
 * `pnpm test:route-edge -u`. A check missing from this table that starts failing
 * is a regression.
 */
const KNOWN_ISSUES: Record<string, { checks: HardCheck[]; observed: string }> = {
  'tabata-fork-yamanote': {
    checks: ['no-forbidden-line', 'no-wrong-line'],
    observed: 'From the 西日暮里 stop the lock moves to 東北新幹線（大宮〜東京）until ~60 s past 田端, then JR山手線.',
  },
  'tabata-fork-yamanote-reverse': {
    checks: ['no-forbidden-line', 'correct-final-line', 'no-wrong-line'],
    observed: 'Approaching 田端 the lock moves to 東北新幹線（大宮〜東京）and stays there to 日暮里.',
  },
  'tabata-fork-keihin-tohoku': {
    checks: ['no-forbidden-line', 'correct-final-line', 'no-wrong-line'],
    observed: 'From the 西日暮里 stop the lock moves to 東北新幹線（大宮〜東京）and never returns to 東北線（田端〜東十条・2）.',
  },
  'tabata-fork-keihin-tohoku-reverse': {
    checks: ['no-forbidden-line', 'correct-final-line', 'no-wrong-line'],
    observed: 'Approaching 田端 the lock moves to 東北新幹線（大宮〜東京）and stays there to 日暮里.',
  },
  'shinagawa-fork-yamanote': {
    checks: ['no-wrong-line'],
    observed: 'Leaving 品川 southbound, 京急「本線」is shown for ~46 s.',
  },
  'shinagawa-fork-yamanote-reverse': {
    checks: ['no-wrong-line'],
    observed: 'Around the 品川 stop 京急「本線」is shown for ~90 s.',
  },
  'shinagawa-fork-keihin-tohoku-reverse': {
    checks: ['no-wrong-line'],
    observed: 'Around the 品川 stop 京急「本線」is shown for ~90 s; nothing is shown for the first ~107 s from 大井町.',
  },
  'tokyo-shinagawa-keihin-tohoku': {
    checks: ['no-wrong-line'],
    observed: 'Between 東京 and 新橋 the lock moves to 8号線有楽町線 for ~55 s.',
  },
  'tokyo-shinagawa-keihin-tohoku-reverse': {
    checks: ['no-wrong-line'],
    observed: 'From 新橋 to 東京 the lock moves to 8号線有楽町線 for ~57 s.',
  },
  'tokyo-ueno-keihin-tohoku': {
    checks: ['no-forbidden-line', 'no-wrong-line'],
    observed: 'Leaving 東京 the bundled straight-line JR東北新幹線 is locked and kept almost to 上野.',
  },
  'tokyo-ueno-keihin-tohoku-reverse': {
    checks: ['no-forbidden-line', 'correct-final-line', 'no-wrong-line'],
    observed: 'Near 秋葉原 the lock moves to the bundled straight-line JR東北新幹線 and stays to 東京.',
  },
  'ochanomizu-ryogoku-sobu-local': {
    checks: ['no-wrong-line'],
    observed: '4号線丸ノ内線 is shown around 御茶ノ水 (~58 s); 両国→錦糸町 shows the rapid 総武線（両国〜東京）.',
  },
  'ochanomizu-ryogoku-sobu-local-reverse': {
    checks: ['no-wrong-line'],
    observed: '両国→浅草橋 shows the rapid 総武線（両国〜東京）for ~48 s; 4号線丸ノ内線 is shown around 御茶ノ水.',
  },
};

const db = new FixtureRailwayDb(loadTokyoCoreFixture());
const resultCache = new Map<string, Promise<ScenarioResult>>();
function resultOf(scenario: EdgeScenario): Promise<ScenarioResult> {
  let result = resultCache.get(scenario.id);
  if (!result) {
    result = runScenario(db, scenario);
    resultCache.set(scenario.id, result);
  }
  return result;
}

describe('route edge-case fixture', () => {
  it('slices the published dataset and adds the synthetic Tokaido Shinkansen', () => {
    const fixture = loadTokyoCoreFixture();
    expect(fixture.meta.datasetVersion).toBe('1.4.0');
    expect(fixture.meta.attribution).toContain('国土数値情報');
    expect(fixture.segments.some((segment) => segment.id === 'synthetic-segment-tokaido-shinkansen-tokyo-shinagawa')).toBe(true);
  });

  it('generates identical traces for the same scenario', () => {
    for (const scenario of EDGE_SCENARIOS) {
      const first = generateTrace(db, scenario.id, scenario.runs, { initialDwellS: scenario.initialDwellS });
      const second = generateTrace(db, scenario.id, scenario.runs, { initialDwellS: scenario.initialDwellS });
      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
    }
  });

  it('lists known issues only for existing scenarios', () => {
    const ids = new Set(EDGE_SCENARIOS.map((scenario) => scenario.id));
    expect(Object.keys(KNOWN_ISSUES).filter((id) => !ids.has(id))).toEqual([]);
  });
});

describe.each(EDGE_SCENARIOS)('$id: $title', (scenario) => {
  const known = new Set(KNOWN_ISSUES[scenario.id]?.checks ?? []);
  const hardCheck = (check: HardCheck, title: string, assertion: (result: ScenarioResult) => void) => {
    const isKnown = known.has(check);
    (isKnown ? it.fails : it)(`${title}${isKnown ? ' [known issue]' : ''}`, async () => {
      assertion(await resultOf(scenario));
    });
  };

  hardCheck('no-forbidden-line', 'never shows a forbidden parallel line', ({ summary }) => {
    expect(summary.forbiddenLineS).toBe(0);
  });

  hardCheck('correct-final-line', 'ends on an accepted line for the last run', ({ ticks }) => {
    const lastRun = scenario.runs[scenario.runs.length - 1];
    expect(lastRun.accept).toContain(ticks[ticks.length - 1].displayedLineId);
  });

  hardCheck('no-wrong-line', 'shows no line outside the accepted set once settled', ({ summary }) => {
    expect(summary.wrongLineS).toBe(0);
  });

  // Baseline of how the matcher behaves today. A diff here is a behaviour change:
  // review it (better or worse?) and re-record with -u only when it is intended.
  it('matches the recorded baseline', async () => {
    expect((await resultOf(scenario)).summary).toMatchSnapshot();
  });
});
