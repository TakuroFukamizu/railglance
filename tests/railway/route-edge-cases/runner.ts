import { DEFAULT_TRACKING_CONFIG, TrackingConfig } from '../../../src/config/tracking-config';
import { RouteLockState, shouldDisplaySelectedRoute } from '../../../src/domain/models/railway';
import { MapMatcher } from '../../../src/domain/railway/map-matcher';
import { FixtureRailwayDb } from './fixture-db';
import { EdgeScenario } from './scenarios';
import { generateTrace, TRACE_START_TIMESTAMP_MS, TracePoint } from './trace';

export type Tick = {
  /** Seconds since the first fix of the trace (not the fix count: GPS can drop out). */
  t: number;
  index: number;
  runIndex: number;
  phase: TracePoint['phase'];
  /** Seconds this fix stands for, from the gap to the next fix, so an outage is not free. */
  durationS: number;
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
  /** Longest single stretch of one wrong line: 10 s + 10 s and 19 s + 1 s differ on the HUD. */
  longestWrongSpanS: number;
  /** Each wrong stretch as `line duration @start`, longest first. */
  wrongSpans: string[];
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

/**
 * What the summary measures is the line MapMatcher allows on the HUD
 * (`shouldDisplaySelectedRoute`). Production adds JourneyStateEstimator and the
 * app-controller's `routeMatchLossGraceMs` window on top, so a wrong line can
 * linger a few seconds longer on a device than it does here; that layer is
 * covered by tests/app/app-controller-route-loss.test.ts.
 */
export async function runScenario(
  db: FixtureRailwayDb,
  scenario: EdgeScenario,
  config: TrackingConfig = DEFAULT_TRACKING_CONFIG
): Promise<ScenarioResult> {
  const matcher = new MapMatcher(db, config);
  const trace = generateTrace(db, scenario.id, scenario.runs, {
    initialDwellS: scenario.initialDwellS,
    startTimestampMs: TRACE_START_TIMESTAMP_MS,
  });
  const settleS = scenario.settleS ?? DEFAULT_SETTLE_S;
  const forbidden = new Set(scenario.forbiddenLineIds ?? []);
  const startMs = TRACE_START_TIMESTAMP_MS;
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

    const nextPoint = trace[index + 1];
    ticks.push({
      t: Math.round((point.sample.timestampMs - startMs) / 1000),
      index,
      runIndex: point.runIndex,
      phase: point.phase,
      durationS: nextPoint ? Math.round((nextPoint.sample.timestampMs - point.sample.timestampMs) / 1000) : 1,
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

function seconds(ticks: Tick[]): number {
  return ticks.reduce((total, tick) => total + tick.durationS, 0);
}

/** Line names are not unique in MLIT data (two 本線 in this fixture); keep them distinguishable. */
function lineNamer(db: FixtureRailwayDb): (lineId: string | null) => string {
  const counts = new Map<string, number>();
  for (const line of db.allLines()) counts.set(line.name, (counts.get(line.name) ?? 0) + 1);
  return (lineId) => {
    if (lineId === null) return '—';
    const line = db.line(lineId);
    return (counts.get(line.name) ?? 0) > 1 ? `${line.name}#${lineId.slice(-4)}` : line.name;
  };
}

function summarize(db: FixtureRailwayDb, scenario: EdgeScenario, ticks: Tick[], forbidden: Set<string>): ScenarioSummary {
  const name = lineNamer(db);
  const firstDisplay = ticks.find((tick) => tick.displayedLineId !== null) ?? null;

  let lineChanges = 0;
  let lastShown: string | null = null;
  for (const tick of ticks) {
    if (tick.displayedLineId === null) continue;
    if (lastShown !== null && tick.displayedLineId !== lastShown) lineChanges++;
    lastShown = tick.displayedLineId;
  }

  const shown = ticks.filter((tick) => tick.displayedLineId !== null);
  const wrongTicks = shown.filter((tick) => !tick.allowedLineIds.has(tick.displayedLineId!));
  const wrongSpans: Array<{ lineId: string; startS: number; durationS: number }> = [];
  for (const tick of wrongTicks) {
    const open = wrongSpans[wrongSpans.length - 1];
    const continues = open && open.lineId === tick.displayedLineId && open.startS + open.durationS === tick.t;
    if (continues) open.durationS += tick.durationS;
    else wrongSpans.push({ lineId: tick.displayedLineId!, startS: tick.t, durationS: tick.durationS });
  }
  wrongSpans.sort((a, b) => b.durationS - a.durationS);

  const runs = scenario.runs.map((run, runIndex) => {
    const runTicks = ticks.filter((tick) => tick.runIndex === runIndex);
    const counts = new Map<string, number>();
    for (const tick of runTicks) {
      counts.set(name(tick.displayedLineId), (counts.get(name(tick.displayedLineId)) ?? 0) + tick.durationS);
    }
    const breakdown = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([line, total]) => `${line} ${total}s`)
      .join(', ');
    return `${run.label}: ${breakdown}`;
  });

  return {
    fixes: ticks.length,
    firstDisplayAtS: firstDisplay?.t ?? null,
    displayedLines: dedupe(ticks.map((tick) => name(tick.displayedLineId))),
    lockStates: dedupe(ticks.map((tick) => tick.lockState ?? 'NO_MATCH')),
    lineChanges,
    wrongLineS: seconds(wrongTicks),
    longestWrongSpanS: wrongSpans[0]?.durationS ?? 0,
    wrongSpans: wrongSpans.map((span) => `${name(span.lineId)} ${span.durationS}s @${span.startS}s`),
    forbiddenLineS: seconds(shown.filter((tick) => forbidden.has(tick.displayedLineId!))),
    hiddenAfterFirstLockS: firstDisplay
      ? seconds(ticks.filter((tick) => tick.t > firstDisplay.t && tick.displayedLineId === null))
      : 0,
    finalLine: name(ticks[ticks.length - 1]?.displayedLineId ?? null),
    runs,
  };
}
