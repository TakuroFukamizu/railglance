import { describe, expect, it } from 'vitest';
import { DEFAULT_RIDE_HISTORY_CONFIG as defaults, type RideHistoryConfig } from '../../src/config/ride-history-config';
import { haversineDistance } from '../../src/domain/geo/distance';
import type { EstimationLogEntry } from '../../src/infrastructure/logging/logger';
import type { JourneyState, RouteLockState } from '../../src/domain/models/railway';
import {
  createInitialRideRecorderState, reduceRideTick, toRideTick, finalizeDanglingRecord,
  type RideTick, type RideRecorderEffect,
} from '../../src/domain/history/ride-recorder';

const line = { id: 'L1', name: '山手線', operatorName: null };
const A = { id: 'A', name: '東京' };
const B = { id: 'B', name: '神田' };
function tick(overrides: Partial<RideTick> = {}): RideTick {
  const timestampMs = overrides.timestampMs ?? 0;
  return {
    timestampMs, committed: true, tracking: true, line, directionName: '外回り',
    previousStation: null, isStopped: false, speedKmh: 72,
    location: { latitude: 35.68 + timestampMs / 1000 * 0.00018, longitude: 139.76, accuracyMeters: 10, timestampMs },
    ...overrides,
  };
}
function ticks(from: number, to: number, overrides: Partial<RideTick> = {}): RideTick[] {
  return Array.from({ length: (to - from) / 1000 + 1 }, (_, i) => tick({ timestampMs: from + i * 1000, ...overrides }));
}
function run(inputs: RideTick[], config: RideHistoryConfig = defaults, newId?: () => string) {
  let state = createInitialRideRecorderState();
  const effects: RideRecorderEffect[] = [];
  let id = 0;
  const nextId = newId ?? (() => `ride-${++id}`);
  for (const input of inputs) {
    const result = reduceRideTick(state, input, config, nextId);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}
function entry(lockState: RouteLockState | undefined = 'LOCKED', status: JourneyState['status'] = 'TRACKING'): EstimationLogEntry {
  return {
    timestampMs: 1000,
    rawLocation: { latitude: 35.68, longitude: 139.76, accuracyMeters: 20, timestampMs: 900, speedMps: 10, headingDegrees: 90 },
    speedState: { isStopped: true, smoothedSpeedKmh: 36 },
    match: { lockState, selectedLine: { id: 'different' } },
    journey: { line: { id: 'L1', name: '山手線' }, status, directionName: '外回り', previousStation: { ...A, sequence: 1, latitude: 35.68 } },
  } as unknown as EstimationLogEntry;
}

describe('toRideTick', () => {
  it('maps every lock state and requires both match and journey line', () => {
    for (const lock of ['LOCKED', 'SUSPICIOUS', 'MANUAL_LOCK', undefined] as const) {
      const input = entry();
      input.match!.lockState = lock;
      expect(toRideTick(input).committed).toBe(true);
    }
    for (const lock of ['UNRESOLVED', 'REACQUIRING'] as const) expect(toRideTick(entry(lock)).committed).toBe(false);
    expect(toRideTick({ ...entry(), match: null }).committed).toBe(false);
    const input = entry();
    input.journey.line = null;
    expect(toRideTick(input).committed).toBe(false);
  });

  it('maps tracking and projects only the required fields', () => {
    expect(toRideTick(entry())).toEqual({
      timestampMs: 1000, committed: true, tracking: true, line, directionName: '外回り', previousStation: A,
      isStopped: true, speedKmh: 36,
      location: { latitude: 35.68, longitude: 139.76, accuracyMeters: 20, timestampMs: 900 },
    });
    for (const status of ['INITIALIZING', 'WAITING_FOR_GPS', 'MATCHING_ROUTE', 'GPS_UNAVAILABLE', 'ROUTE_UNCERTAIN', 'GPS_LOW_ACCURACY'] as const) {
      expect(toRideTick(entry('LOCKED', status)).tracking).toBe(false);
    }
    const input = entry();
    input.rawLocation = null;
    input.journey.previousStation = null;
    input.journey.line!.operatorName = 'JR';
    expect(toRideTick(input)).toMatchObject({ location: null, previousStation: null, line: { operatorName: 'JR' } });
    input.journey.line = null;
    expect(toRideTick(input).line).toBeNull();
  });
});

describe('reduceRideTick', () => {
  it('promotes at exactly 30 seconds and persists once with the injected id', () => {
    let calls = 0;
    const newId = () => { calls += 1; return 'ride-1'; };
    const before = run(ticks(0, 29_000), defaults, newId);
    expect(before.state.phase).toBe('candidate');
    expect(before.state.record).toBeNull();
    expect(before.effects).toEqual([]);
    expect(calls).toBe(0);
    const result = reduceRideTick(before.state, tick({ timestampMs: 30_000 }), defaults, newId);
    expect(result.state.phase).toBe('riding');
    expect(result.state.record).toMatchObject({ id: 'ride-1', startedAtMs: 0, status: 'open' });
    expect(result.effects).toEqual([{ type: 'persist', record: result.state.record }]);
    expect(result.state.lastPersistedAtMs).toBe(30_000);
    expect(calls).toBe(1);
  });
});

function step(state: ReturnType<typeof run>['state'], input: RideTick) {
  return reduceRideTick(state, input, defaults, () => 'next-ride');
}
function distance(a: RideTick, b: RideTick): number {
  return haversineDistance(a.location!.latitude, a.location!.longitude, b.location!.latitude, b.location!.longitude);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe('ride lifecycle and measurements', () => {
  it('stays idle for 60 seconds of committed tracking stopped ticks', () => {
    const result = run(ticks(0, 60_000, { isStopped: true }));
    expect(result.state).toEqual(createInitialRideRecorderState());
    expect(result.effects).toEqual([]);
  });

  it('resets a candidate on a non-committed tick', () => {
    const result = run([...ticks(0, 20_000), tick({ timestampMs: 21_000, committed: false })]);
    expect(result.state).toEqual(createInitialRideRecorderState());
    expect(result.effects).toEqual([]);
  });

  it('does not start a candidate from committed non-tracking ticks', () => {
    const result = run(ticks(0, 60_000, { tracking: false }));
    expect(result.state.phase).toBe('idle');
    expect(result.effects).toEqual([]);
  });

  it('keeps the first non-null station and persists only station changes', () => {
    const initial = run([...ticks(0, 9000), ...ticks(10_000, 30_000, { previousStation: A })]);
    expect(initial.state.record).toMatchObject({ fromStation: A, passedStations: [A] });
    const same = step(initial.state, tick({ timestampMs: 31_000, previousStation: A }));
    expect(same.effects).toEqual([]);
    const changed = step(same.state, tick({ timestampMs: 32_000, previousStation: B }));
    expect(changed.state.record).toMatchObject({ fromStation: A, passedStations: [A, B] });
    expect(changed.effects).toEqual([{ type: 'persist', record: changed.state.record }]);
    const repeated = step(changed.state, tick({ timestampMs: 33_000, previousStation: B }));
    expect(repeated.state.record!.passedStations).toEqual([A, B]);
    expect(repeated.effects).toEqual([]);
  });

  it('persists periodically at 30 seconds but not before', () => {
    let state = run(ticks(0, 30_000)).state;
    for (const input of ticks(31_000, 59_000)) {
      const result = step(state, input);
      expect(result.effects).toEqual([]);
      expect(result.state.record!.updatedAtMs).toBe(30_000);
      state = result.state;
    }
    const result = step(state, tick({ timestampMs: 60_000 }));
    expect(result.effects).toEqual([{ type: 'persist', record: result.state.record }]);
    expect(result.state.record!.updatedAtMs).toBe(60_000);
    expect(result.state.lastPersistedAtMs).toBe(60_000);
  });

  it('closes a transfer at the old last tick and promotes the new line with a fresh id', () => {
    let calls = 0;
    const newId = () => `ride-${++calls}`;
    const old = run(ticks(0, 120_000), defaults, newId);
    const newLine = { ...line, id: 'L2' };
    const result = reduceRideTick(old.state, tick({ timestampMs: 121_000, line: newLine, tracking: false }), defaults, newId);
    expect(result.effects).toEqual([{ type: 'close', record: expect.objectContaining({ endReason: 'transfer', endedAtMs: 120_000, lineId: 'L1', updatedAtMs: 121_000 }) }]);
    expect(result.state).toMatchObject({ phase: 'candidate', candidateLine: newLine, candidateSinceMs: 121_000, record: null });
    let state = result.state;
    for (const input of ticks(122_000, 151_000, { line: newLine, tracking: false })) state = reduceRideTick(state, input, defaults, newId).state;
    expect(state.record).toMatchObject({ startedAtMs: 121_000, id: 'ride-2', lineId: 'L2' });
    expect(calls).toBe(2);
  });

  it('discards a transfer when the old ride is too short', () => {
    const state = run(ticks(0, 60_000)).state;
    expect(step(state, tick({ timestampMs: 61_000, line: { ...line, id: 'L2' } })).effects)
      .toEqual([{ type: 'discard', recordId: 'ride-1' }]);
  });

  it('closes after 180 seconds of non-committed ticks, but not at 179 seconds', () => {
    // D11 starts the timer at the first lost tick, one second after the last committed tick.
    const result = run([...ticks(0, 120_000), ...ticks(121_000, 300_000, { committed: false })]);
    expect(result.state.phase).toBe('riding');
    expect(result.state.lostSinceMs).toBe(121_000);
    expect(result.effects.filter(effect => effect.type !== 'persist')).toEqual([]);
    const closed = step(result.state, tick({ timestampMs: 301_000, committed: false }));
    expect(closed.effects).toEqual([{ type: 'close', record: expect.objectContaining({ endReason: 'route-lost', endedAtMs: 120_000 }) }]);
    expect(closed.state.phase).toBe('idle');
  });

  it('closes after exactly 600 seconds stopped at the stop start time', () => {
    const result = run([...ticks(0, 120_000), ...ticks(121_000, 720_000, { isStopped: true, location: null })]);
    expect(result.state.phase).toBe('riding');
    expect(result.effects.filter(effect => effect.type !== 'persist')).toEqual([]);
    const closed = step(result.state, tick({ timestampMs: 721_000, isStopped: true, location: null }));
    expect(closed.effects).toEqual([{ type: 'close', record: expect.objectContaining({ endReason: 'stopped', endedAtMs: 121_000 }) }]);
    expect(closed.state.phase).toBe('idle');
  });

  it('resets the stop timer on a moving tick', () => {
    const first = run([...ticks(0, 120_000), ...ticks(121_000, 421_000, { isStopped: true, location: null })]);
    const moving = step(first.state, tick({ timestampMs: 422_000, location: null }));
    expect(moving.state.stoppedSinceMs).toBeNull();
    let state = moving.state;
    for (const input of ticks(423_000, 1_022_000, { isStopped: true, location: null })) {
      const result = step(state, input);
      expect(result.effects.every(effect => effect.type === 'persist')).toBe(true);
      state = result.state;
    }
    expect(state.phase).toBe('riding');
    expect(state.stoppedSinceMs).toBe(423_000);
  });

  it('ignores inaccurate samples entirely and connects the good neighbors', () => {
    const a = tick();
    const bad = tick({ timestampMs: 1000 });
    bad.location!.accuracyMeters = 150;
    const b = tick({ timestampMs: 2000 });
    const first = run([a]);
    const ignored = step(first.state, bad);
    expect(ignored.state.lastLocation).toEqual(first.state.lastLocation);
    expect(ignored.state.candidateDistanceMeters).toBe(0);
    const result = step(ignored.state, b);
    expect(result.state.candidateDistanceMeters).toBeCloseTo(distance(a, b), 8);
  });

  it('excludes a jump over 5 km but uses its location as the next baseline', () => {
    const a = tick();
    const jump = tick({ timestampMs: 1000, location: { latitude: 36, longitude: 139.76, accuracyMeters: 10, timestampMs: 1000 } });
    const b = tick({ timestampMs: 2000, location: { ...jump.location!, latitude: 36.00018, timestampMs: 2000 } });
    expect(distance(a, jump)).toBeGreaterThan(5000);
    const jumped = run([a, jump]);
    expect(jumped.state.candidateDistanceMeters).toBe(0);
    expect(jumped.state.lastLocation).toEqual({ latitude: 36, longitude: 139.76, timestampMs: 1000 });
    expect(step(jumped.state, b).state.candidateDistanceMeters).toBeCloseTo(distance(jump, b), 8);
  });

  it('skips duplicate GPS timestamps on later ticks', () => {
    const first = tick();
    const repeated = tick({ timestampMs: 1000, location: { ...tick({ timestampMs: 1000 }).location!, timestampMs: 0 } });
    const result = run([first, repeated]);
    expect(result.state.candidateDistanceMeters).toBe(0);
    expect(result.state.lastLocation).toEqual({ latitude: 35.68, longitude: 139.76, timestampMs: 0 });
  });

  it('includes all candidate distance in the promoted record', () => {
    const inputs = ticks(0, 30_000);
    const expected = inputs.slice(1).reduce((sum, input, i) => sum + distance(inputs[i], input), 0);
    expect(expected).toBeGreaterThan(500);
    expect(run(inputs).state.record!.distanceMeters).toBeCloseTo(expected, 8);
  });

  it('keeps riding with unchanged distance when location is null', () => {
    const state = run(ticks(0, 30_000)).state;
    const result = step(state, tick({ timestampMs: 31_000, location: null }));
    expect(result.state.phase).toBe('riding');
    expect(result.state.record!.distanceMeters).toBe(state.record!.distanceMeters);
    expect(result.state.lastLocation).toEqual(state.lastLocation);
  });

  it('discards route-lost rides under two minutes even with sufficient distance', () => {
    const result = run([...ticks(0, 90_000), ...ticks(91_000, 271_000, { committed: false })]);
    expect(result.effects.at(-1)).toEqual({ type: 'discard', recordId: 'ride-1' });
    expect(result.effects.some(effect => effect.type === 'close')).toBe(false);
  });

  it('discards rides over two minutes with only about 100 meters', () => {
    const inputs = ticks(0, 120_000).map(input => ({ ...input, location: { ...input.location!, latitude: 35.68 + input.timestampMs / 120_000 * 0.0009 } }));
    const state = run(inputs).state;
    expect(state.record!.distanceMeters).toBeCloseTo(distance(inputs[0], inputs.at(-1)!), 6);
    expect(state.record!.distanceMeters).toBeLessThan(500);
    const result = run([...inputs, ...ticks(121_000, 301_000, { committed: false })]);
    expect(result.effects.at(-1)).toEqual({ type: 'discard', recordId: 'ride-1' });
  });

  it('tracks maximum committed speed and the last non-null station at close', () => {
    const result = run([
      ...ticks(0, 10_000, { speedKmh: 110, previousStation: A }),
      ...ticks(11_000, 30_000, { speedKmh: null }),
      ...ticks(31_000, 119_000, { speedKmh: 120, previousStation: B }),
      tick({ timestampMs: 120_000, speedKmh: null }),
      ...ticks(121_000, 301_000, { committed: false, speedKmh: 999, previousStation: { id: 'C', name: '無視' } }),
    ]);
    const promoted = result.effects[0];
    expect(promoted).toMatchObject({ type: 'persist', record: { maxSpeedKmh: 110 } });
    expect(result.effects.at(-1)).toMatchObject({ type: 'close', record: { maxSpeedKmh: 120, toStation: B } });
  });

  it('continues riding for 120 seconds through committed non-tracking tunnel ticks', () => {
    const result = run([...ticks(0, 30_000), ...ticks(31_000, 150_000, { tracking: false })]);
    expect(result.state.phase).toBe('riding');
    expect(result.state.lostSinceMs).toBeNull();
    expect(result.effects.every(effect => effect.type === 'persist')).toBe(true);
  });

  it('ignores clock rollback unchanged and resumes on normal ticks', () => {
    const state = run(ticks(0, 30_000)).state;
    for (const timestampMs of [29_000, 30_000]) {
      const result = step(state, tick({ timestampMs, line: { ...line, id: 'L2' } }));
      expect(result.state).toBe(state);
      expect(result.effects).toEqual([]);
      expect(result.state.record!.distanceMeters).toBe(state.record!.distanceMeters);
    }
    const normal = step(state, tick({ timestampMs: 31_000 }));
    expect(normal.state.record!.distanceMeters).toBeGreaterThan(state.record!.distanceMeters);
    expect(normal.state.lastCommittedAtMs).toBe(31_000);
  });

  it('does not mutate frozen input state, records or station arrays', () => {
    const state = freeze(run(ticks(0, 30_000, { previousStation: A })).state);
    const result = step(state, tick({ timestampMs: 31_000, previousStation: B }));
    expect(result.state).not.toBe(state);
    expect(result.state.record).not.toBe(state.record);
    expect(state.record!.passedStations).toEqual([A]);
    expect(result.state.record!.passedStations).toEqual([A, B]);
    expect(result.state.record!.distanceMeters).toBeGreaterThan(state.record!.distanceMeters);
  });

  it('finalizes dangling rides at updatedAtMs without mutation and filters short rides', () => {
    const record = freeze(run(ticks(0, 120_000, { previousStation: A })).state.record!);
    const closed = finalizeDanglingRecord(record, defaults);
    expect(closed).toMatchObject({ status: 'closed', endReason: 'app-restart', endedAtMs: 120_000, toStation: A });
    expect(closed).not.toBe(record);
    expect(record).toMatchObject({ status: 'open', endedAtMs: null, endReason: null, toStation: null });
    expect(finalizeDanglingRecord({ ...record, updatedAtMs: 119_999 }, defaults)).toBeNull();
    expect(finalizeDanglingRecord({ ...record, distanceMeters: 499.99 }, defaults)).toBeNull();
    expect(finalizeDanglingRecord({ ...record, distanceMeters: 500 }, defaults)).not.toBeNull();
    expect(finalizeDanglingRecord({ ...record, toStation: B }, defaults)!.toStation).toEqual(B);
    expect(finalizeDanglingRecord({ ...record, passedStations: [] }, defaults)!.toStation).toBeNull();
  });

  it('creates a fresh idle state with exactly the prescribed defaults', () => {
    const state = createInitialRideRecorderState();
    expect(state).toEqual({
      phase: 'idle', record: null, candidateSinceMs: null, sawMovingTick: false,
      lostSinceMs: null, stoppedSinceMs: null, lastCommittedAtMs: null, lastLocation: null,
      lastPersistedAtMs: null, firstStation: null, lastStation: null, candidateLine: null,
      candidateDirectionName: null, candidateDistanceMeters: 0, candidateMaxSpeedKmh: null,
    });
    expect(createInitialRideRecorderState()).not.toBe(state);
  });
});

describe('decision edge cases', () => {
  it('restarts a candidate on a different line even without tracking', () => {
    const before = run(ticks(0, 29_000, { previousStation: A })).state;
    const switched = step(freeze(before), tick({ timestampMs: 30_000, tracking: false, line: { ...line, id: 'L2' }, previousStation: B, directionName: '内回り' }));
    expect(switched.effects).toEqual([]);
    expect(switched.state).toMatchObject({ phase: 'candidate', candidateSinceMs: 30_000, candidateDistanceMeters: 0, candidateLine: { id: 'L2' }, firstStation: B, lastStation: B });
    const promoted = step(switched.state, tick({ timestampMs: 60_000, tracking: false, line: { ...line, id: 'L2' } }));
    expect(promoted.state.record).toMatchObject({ lineId: 'L2', startedAtMs: 30_000, directionName: '内回り', passedStations: [B] });
  });

  it('starts confirmation and ride duration at departure after opening while stopped', () => {
    const state = run(ticks(0, 60_000, { isStopped: true })).state;
    const departure = step(state, tick({ timestampMs: 61_000 }));
    expect(departure.state).toMatchObject({ phase: 'candidate', candidateSinceMs: 61_000, sawMovingTick: true, record: null });
    expect(departure.effects).toEqual([]);
    let candidate = departure.state;
    for (const input of ticks(62_000, 90_000)) {
      const result = step(candidate, input);
      expect(result.state.phase).toBe('candidate');
      expect(result.effects).toEqual([]);
      candidate = result.state;
    }
    const promoted = step(candidate, tick({ timestampMs: 91_000 }));
    expect(promoted.state.phase).toBe('riding');
    expect(promoted.state.record!.startedAtMs).toBe(61_000);
    expect(promoted.state.stoppedSinceMs).toBeNull();
    expect(promoted.effects).toHaveLength(1);
  });

  it('stays idle after a stopped close until the next departure', () => {
    const closed = run([...ticks(0, 120_000), ...ticks(121_000, 721_000, { isStopped: true, location: null })]);
    expect(closed.effects.at(-1)).toMatchObject({ type: 'close', record: { endReason: 'stopped' } });
    let state = closed.state;
    for (const input of ticks(722_000, 782_000, { isStopped: true, location: null })) {
      const result = step(state, input);
      expect(result.state).toEqual(createInitialRideRecorderState());
      expect(result.effects).toEqual([]);
      state = result.state;
    }
    const departure = step(state, tick({ timestampMs: 783_000 }));
    expect(departure.state).toMatchObject({ phase: 'candidate', candidateSinceMs: 783_000, record: null });
    expect(departure.effects).toEqual([]);
    const promoted = step(departure.state, tick({ timestampMs: 813_000 }));
    expect(promoted.state.record!.startedAtMs).toBe(783_000);
  });

  it('closes or discards a stopped transfer and waits idle for the new line departure', () => {
    const newLine = { ...line, id: 'L2' };
    for (const duration of [60_000, 120_000]) {
      const before = run(ticks(0, duration)).state;
      const transferred = step(before, tick({ timestampMs: duration + 1000, line: newLine, isStopped: true }));
      expect(transferred.effects).toEqual(duration === 60_000
        ? [{ type: 'discard', recordId: 'ride-1' }]
        : [{ type: 'close', record: expect.objectContaining({ endReason: 'transfer', endedAtMs: duration, lineId: 'L1' }) }]);
      expect(transferred.state).toEqual(createInitialRideRecorderState());
      const waiting = step(transferred.state, tick({ timestampMs: duration + 2000, line: newLine, isStopped: true }));
      expect(waiting.state.phase).toBe('idle');
      expect(waiting.effects).toEqual([]);
      const departure = step(waiting.state, tick({ timestampMs: duration + 3000, line: newLine }));
      expect(departure.state).toMatchObject({ phase: 'candidate', candidateSinceMs: duration + 3000, candidateLine: newLine });
      expect(departure.effects).toEqual([]);
    }
  });

  it('resets a candidate to idle when the new line tick is stopped', () => {
    const before = run(ticks(0, 29_000)).state;
    const newLine = { ...line, id: 'L2' };
    const switched = step(before, tick({ timestampMs: 30_000, line: newLine, isStopped: true }));
    expect(switched.state).toEqual(createInitialRideRecorderState());
    expect(switched.effects).toEqual([]);
    const untracked = step(switched.state, tick({ timestampMs: 31_000, line: newLine, tracking: false }));
    expect(untracked.state.phase).toBe('idle');
    const departure = step(untracked.state, tick({ timestampMs: 32_000, line: newLine }));
    expect(departure.state).toMatchObject({ phase: 'candidate', candidateSinceMs: 32_000, candidateLine: newLine });
    expect(departure.effects).toEqual([]);
  });

  it('still promotes after 30 committed seconds when departure is followed by stopped ticks', () => {
    const result = run([tick(), ...ticks(1000, 30_000, { isStopped: true })]);
    expect(result.state).toMatchObject({ phase: 'riding', sawMovingTick: true, record: { startedAtMs: 0 } });
    expect(result.effects).toEqual([{ type: 'persist', record: result.state.record }]);
  });

  it('uses first and last candidate stations and fills stations first seen while riding', () => {
    const promoted = run([
      ...ticks(0, 9000, { previousStation: A }),
      ...ticks(10_000, 30_000, { previousStation: B }),
    ]);
    expect(promoted.state.record!.passedStations).toEqual([A, B]);
    const empty = run(ticks(0, 30_000)).state;
    const observed = step(empty, tick({ timestampMs: 31_000, previousStation: A }));
    expect(observed.state.record).toMatchObject({ fromStation: A, passedStations: [A] });
    expect(observed.effects).toHaveLength(1);
  });

  it('skips older GPS fixes without skipping later tick timers', () => {
    const state = run(ticks(0, 30_000)).state;
    const result = step(state, tick({ timestampMs: 60_000, location: tick({ timestampMs: 29_000 }).location }));
    expect(result.state.lastLocation).toEqual(state.lastLocation);
    expect(result.state.record!.distanceMeters).toBe(state.record!.distanceMeters);
    expect(result.state.lastCommittedAtMs).toBe(60_000);
    expect(result.effects).toHaveLength(1);
  });

  it('clears route loss on recovery and ignores non-committed measurements', () => {
    const state = run(ticks(0, 120_000, { previousStation: A })).state;
    const lost = step(state, tick({ timestampMs: 121_000, committed: false, previousStation: B, speedKmh: 999 }));
    expect(lost.effects).toEqual([]);
    expect(lost.state.record).toEqual(state.record);
    expect(lost.state.lastLocation).toEqual(state.lastLocation);
    const recovered = step(lost.state, tick({ timestampMs: 122_000, location: null }));
    expect(recovered.state.lostSinceMs).toBeNull();
    expect(recovered.state.record!.toStation).toBeNull();
    const lostAgain = step(recovered.state, tick({ timestampMs: 123_000, committed: false }));
    expect(lostAgain.state.lostSinceMs).toBe(123_000);
  });

  it('emits only one persist when a station change coincides with the interval', () => {
    const state = run(ticks(0, 30_000)).state;
    const result = step(state, tick({ timestampMs: 60_000, previousStation: A }));
    expect(result.effects).toEqual([{ type: 'persist', record: result.state.record }]);
    expect(result.state.record!.updatedAtMs).toBe(60_000);
  });

  it('closes on a non-committed stopped tick without an additional persist', () => {
    const config = { ...defaults, stoppedEndMs: 1000 };
    const initial = run(ticks(0, 120_000), config).state;
    const stopped = reduceRideTick(initial, tick({ timestampMs: 121_000, isStopped: true }), config).state;
    const lost = reduceRideTick(stopped, tick({ timestampMs: 122_000, committed: false, isStopped: true }), config);
    expect(lost.effects).toEqual([{ type: 'close', record: expect.objectContaining({ endedAtMs: 121_000, endReason: 'stopped' }) }]);
    expect(lost.state.phase).toBe('idle');
  });

  it('closes after 600 stopped seconds even when the last 100 seconds lack a committed lock', () => {
    const stopStart = 121_000;
    const result = run([
      ...ticks(0, 120_000),
      ...ticks(stopStart, stopStart + 499_000, { isStopped: true, location: null }),
      ...ticks(stopStart + 500_000, stopStart + 599_000, { committed: false, isStopped: true, location: null }),
    ]);
    expect(result.state.phase).toBe('riding');
    expect(result.state.stoppedSinceMs).toBe(stopStart);
    expect(result.state.lostSinceMs).toBe(stopStart + 500_000);
    expect(result.effects.filter(effect => effect.type !== 'persist')).toEqual([]);
    const closed = step(result.state, tick({ timestampMs: stopStart + 600_000, committed: false, isStopped: true, location: null }));
    expect(closed.effects).toEqual([{ type: 'close', record: expect.objectContaining({ endedAtMs: stopStart, endReason: 'stopped' }) }]);
    expect(closed.state.phase).toBe('idle');
  });
});
