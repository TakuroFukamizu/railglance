import { describe, expect, it } from 'vitest';
import { FixtureRailwayDb, loadTokyoCoreFixture } from './fixture-db';
import { runScenario, ScenarioResult } from './runner';
import { EDGE_SCENARIOS, EdgeScenario } from './scenarios';
import { buildTracePaths, generateTrace } from './trace';

type HardCheck = 'no-forbidden-line' | 'correct-final-line' | 'no-wrong-line';

/**
 * Hard expectations the current MapMatcher does not meet yet (dataset v1.4.0,
 * DEFAULT_TRACKING_CONFIG). They run as it.fails, so a logic change that fixes
 * one turns that test red: delete the entry and re-record the baseline with
 * `pnpm test:route-edge -u`. A check missing from this table that starts failing
 * is a regression.
 *
 * `maxWrongLineS` is checked as an ordinary test, because `it.fails` passes for any
 * failure: without a ceiling a known issue that got worse would still look green.
 */
const KNOWN_ISSUES: Record<string, { checks: HardCheck[]; observed: string; maxWrongLineS: number }> = {
  'tabata-fork-yamanote': {
    checks: ['no-wrong-line'],
    maxWrongLineS: 7,
    observed: 'Leaving 田端 the 東北線（田端〜日暮里・1）lock is kept ~53 s into 田端→駒込 (stop plus the station hole).',
  },
  'tabata-fork-keihin-tohoku': {
    checks: ['no-wrong-line'],
    maxWrongLineS: 4,
    observed: 'Leaving 田端 the 東北線（田端〜日暮里・1）lock is kept ~49 s into 田端→上中里 (stop plus the station hole).',
  },
  'tokyo-shinagawa-keihin-tohoku': {
    checks: ['no-wrong-line'],
    maxWrongLineS: 11,
    observed: 'Leaving 田町 the 東海道線（田町〜新橋）lock is kept ~56 s into 田町→高輪ゲートウェイ.',
  },
  'shinagawa-transfer-keikyu': {
    checks: ['no-wrong-line'],
    maxWrongLineS: 2,
    observed:
      'Leaving 品川 onto 京急本線 the JR lock is kept ~40 s: for about 400 m the JR end-tangent ' +
      'projection and 京急 are within one accuracy floor of each other.',
  },
  'shinagawa-transfer-keikyu-reverse': {
    checks: ['no-wrong-line'],
    maxWrongLineS: 5,
    observed: 'Approaching 品川 on 京急本線 the lock moves to the JR line ~5 s past the settle window.',
  },
  'sobu-rapid-tunnel-outage-reverse': {
    checks: ['no-wrong-line', 'correct-final-line'],
    maxWrongLineS: 68,
    observed:
      'Heading into the tunnel from 両国, the 総武線（両国〜銚子）lock is kept ~68 s while every fix is ' +
      'either rejected for accuracy or carries no speed/heading, so the rapid tunnel line is never picked up.',
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

  it('rides reverse scenarios in the opposite direction', () => {
    const endpoints = (scenario: EdgeScenario) => {
      const moving = generateTrace(db, scenario.id, scenario.runs, { initialDwellS: scenario.initialDwellS })
        .filter((point) => point.phase === 'run');
      return [moving[0].sample, moving[moving.length - 1].sample];
    };
    const metres = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
      Math.hypot((a.latitude - b.latitude) * 111_320, (a.longitude - b.longitude) * 91_000);

    for (const forward of EDGE_SCENARIOS.filter((scenario) => !scenario.id.endsWith('-reverse'))) {
      const reverse = EDGE_SCENARIOS.find((scenario) => scenario.id === `${forward.id}-reverse`);
      if (!reverse) continue;
      const [forwardStart, forwardEnd] = endpoints(forward);
      const [reverseStart, reverseEnd] = endpoints(reverse);
      // A single-segment run has no neighbour to orient it, so a "reverse" scenario can
      // silently ride the same way with different noise. Ends must swap.
      expect(metres(reverseStart, forwardEnd)).toBeLessThan(metres(reverseStart, forwardStart));
      expect(metres(reverseEnd, forwardStart)).toBeLessThan(metres(reverseEnd, forwardEnd));
    }
  });

  it('never doubles back on itself', () => {
    // Station snapping used to extend a path backwards past its own end, which made the
    // train ride a stretch, reverse onto the platform and ride it again. Checked on the
    // ridden geometry, where GPS noise cannot mask or fake a reversal.
    for (const scenario of EDGE_SCENARIOS) {
      buildTracePaths(db, scenario.runs).forEach((path, runIndex) => {
        const edges: Array<[number, number]> = [];
        for (let i = 1; i < path.length; i++) {
          const edge: [number, number] = [
            (path[i][0] - path[i - 1][0]) * 111_320,
            (path[i][1] - path[i - 1][1]) * 91_000,
          ];
          if (Math.hypot(...edge) >= 10) edges.push(edge);
        }
        const reversals = edges.filter(
          (edge, i) => i > 0 && edges[i - 1][0] * edge[0] + edges[i - 1][1] * edge[1] < 0
        ).length;
        expect(`${scenario.id} run ${runIndex}: ${reversals}`).toBe(`${scenario.id} run ${runIndex}: 0`);
      });
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

  hardCheck('correct-final-line', 'ends on an accepted line for the run it ends in', ({ ticks }) => {
    // Not always the last run: a run can produce no fixes at all (tunnel outage).
    const lastTick = ticks[ticks.length - 1];
    expect(scenario.runs[lastTick.runIndex].accept).toContain(lastTick.displayedLineId);
  });

  hardCheck('no-wrong-line', 'shows no line outside the accepted set once settled', ({ summary }) => {
    expect(summary.wrongLineS).toBe(0);
  });

  const ceiling = KNOWN_ISSUES[scenario.id]?.maxWrongLineS;
  if (ceiling !== undefined) {
    it(`keeps the known wrong-line time at ${ceiling}s or below`, async () => {
      expect((await resultOf(scenario)).summary.wrongLineS).toBeLessThanOrEqual(ceiling);
    });
  }

  // Baseline of how the matcher behaves today. A diff here is a behaviour change:
  // review it (better or worse?) and re-record with -u only when it is intended.
  it('matches the recorded baseline', async () => {
    expect((await resultOf(scenario)).summary).toMatchSnapshot();
  });
});
