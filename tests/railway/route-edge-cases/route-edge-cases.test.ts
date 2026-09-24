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
    checks: ['no-wrong-line'],
    observed: 'Leaving 田端 the 東北線（田端〜日暮里・1）lock is kept ~53 s into 田端→駒込 (stop plus the station hole).',
  },
  'tabata-fork-keihin-tohoku': {
    checks: ['no-wrong-line'],
    observed: 'Leaving 田端 the 東北線（田端〜日暮里・1）lock is kept ~49 s into 田端→上中里 (stop plus the station hole).',
  },
  'tokyo-shinagawa-keihin-tohoku': {
    checks: ['no-wrong-line'],
    observed: 'Leaving 田町 the 東海道線（田町〜新橋）lock is kept ~56 s into 田町→高輪ゲートウェイ.',
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
