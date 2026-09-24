import { DEFAULT_TRACKING_CONFIG, TrackingConfig } from '../../../src/config/tracking-config';
import { RouteLockState, shouldDisplaySelectedRoute } from '../../../src/domain/models/railway';
import { MapMatcher } from '../../../src/domain/railway/map-matcher';
import { FixtureRailwayDb } from './fixture-db';
import { EdgeScenario } from './scenarios';
import { generateTrace, TracePoint } from './trace';

export type Tick = {
  t: number;
  runIndex: number;
  phase: TracePoint['phase'];
  displayedLineId: string | null;
  lockState: RouteLockState | null;
  allowedLineIds: ReadonlySet<string>;
};

export type ScenarioSummary = {
  fixes: number;
  firstDisplayAtS: number | null;
  /** Consecutive-deduplicated line shown on the HUD; '—' while no route is shown. */
  displayedLines: string[];
  lockStates: string[];
  /** Changes from one shown line to a different one (drop-outs to '—' are not counted). */
  lineChanges: number;
  /** Seconds a line outside the run's accepted set (after the settle window) was shown. */
  wrongLineS: number;
  /** Seconds a scenario-forbidden line (e.g. a Shinkansen on a conventional ride) was shown. */
  forbiddenLineS: number;
  /** Seconds with no route shown after the first lock. */
  hiddenAfterFirstLockS: number;
  finalLine: string;
  runs: string[];
};

export type ScenarioResult = { ticks: Tick[]; summary: ScenarioSummary };

/**
 * Seconds after a run starts during which the previous run's lines are still
 * accepted. The default config needs roughly challenger (>=4 s) + reacquire
 * (>=4 s) + relock/confirmation (>=3 s each) once the geometry has separated,
 * and forks take a while to separate beyond GPS noise.
 */
export const DEFAULT_SETTLE_S = 45;

export async function runScenario(
  db: FixtureRailwayDb,
  scenario: EdgeScenario,
  config: TrackingConfig = DEFAULT_TRACKING_CONFIG
): Promise<ScenarioResult> {
  const matcher = new MapMatcher(db, config);
  const trace = generateTrace(db, scenario.id, scenario.runs, { initialDwellS: scenario.initialDwellS });
  const settleS = scenario.settleS ?? DEFAULT_SETTLE_S;
  const forbidden = new Set(scenario.forbiddenLineIds ?? []);
  const ticks: Tick[] = [];

  for (const [index, point] of trace.entries()) {
    const match = await matcher.match(point.sample);
    const run = scenario.runs[point.runIndex];
    const allowed = new Set(run.accept);
    const previous = scenario.runs[point.runIndex - 1];
    if (previous && point.secondsIntoRun < settleS) previous.accept.forEach((id) => allowed.add(id));
    // At a stop the train sits where this run ends and the next one begins.
    const next = scenario.runs[point.runIndex + 1];
    if (next && point.phase === 'dwell') next.accept.forEach((id) => allowed.add(id));

    ticks.push({
      t: index,
      runIndex: point.runIndex,
      phase: point.phase,
      displayedLineId: match && shouldDisplaySelectedRoute(match) ? match.selectedLine.id : null,
      lockState: match?.lockState ?? null,
      allowedLineIds: allowed,
    });
  }

  return { ticks, summary: summarize(db, scenario, ticks, forbidden) };
}

function dedupe(values: string[]): string[] {
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}

function summarize(db: FixtureRailwayDb, scenario: EdgeScenario, ticks: Tick[], forbidden: Set<string>): ScenarioSummary {
  const name = (lineId: string | null) => (lineId === null ? '—' : db.line(lineId).name);
  const firstDisplay = ticks.find((tick) => tick.displayedLineId !== null) ?? null;

  let lineChanges = 0;
  let lastShown: string | null = null;
  for (const tick of ticks) {
    if (tick.displayedLineId === null) continue;
    if (lastShown !== null && tick.displayedLineId !== lastShown) lineChanges++;
    lastShown = tick.displayedLineId;
  }

  const shown = ticks.filter((tick) => tick.displayedLineId !== null);
  const runs = scenario.runs.map((run, runIndex) => {
    const runTicks = ticks.filter((tick) => tick.runIndex === runIndex);
    const counts = new Map<string, number>();
    for (const tick of runTicks) counts.set(name(tick.displayedLineId), (counts.get(name(tick.displayedLineId)) ?? 0) + 1);
    const breakdown = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([line, seconds]) => `${line} ${seconds}s`)
      .join(', ');
    return `${run.label}: ${breakdown}`;
  });

  return {
    fixes: ticks.length,
    firstDisplayAtS: firstDisplay?.t ?? null,
    displayedLines: dedupe(ticks.map((tick) => name(tick.displayedLineId))),
    lockStates: dedupe(ticks.map((tick) => tick.lockState ?? 'NO_MATCH')),
    lineChanges,
    wrongLineS: shown.filter((tick) => !tick.allowedLineIds.has(tick.displayedLineId!)).length,
    forbiddenLineS: shown.filter((tick) => forbidden.has(tick.displayedLineId!)).length,
    hiddenAfterFirstLockS: firstDisplay
      ? ticks.filter((tick) => tick.t > firstDisplay.t && tick.displayedLineId === null).length
      : 0,
    finalLine: name(ticks[ticks.length - 1]?.displayedLineId ?? null),
    runs,
  };
}
