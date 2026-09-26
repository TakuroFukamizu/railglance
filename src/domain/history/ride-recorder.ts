import type { RideHistoryConfig } from '../../config/ride-history-config';
import type { EstimationLogEntry } from '../../infrastructure/logging/logger';
import { haversineDistance } from '../geo/distance';
import { isCommittedRouteLock } from '../models/railway';
import { createRideId, type RideEndReason, type RideRecord, type RideStationRef } from './ride-record';

export type RideTick = {
  timestampMs: number;
  committed: boolean;
  tracking: boolean;
  line: { id: string; name: string; operatorName: string | null } | null;
  directionName: string | null;
  previousStation: RideStationRef | null;
  isStopped: boolean;
  speedKmh: number | null;
  location: { latitude: number; longitude: number; accuracyMeters: number; timestampMs: number } | null;
};
export type RideRecorderPhase = 'idle' | 'candidate' | 'riding';
export type RideRecorderState = {
  phase: RideRecorderPhase;
  record: RideRecord | null;
  candidateSinceMs: number | null;
  sawMovingTick: boolean;
  lostSinceMs: number | null;
  stoppedSinceMs: number | null;
  lastCommittedAtMs: number | null;
  lastLocation: { latitude: number; longitude: number; timestampMs: number } | null;
  lastPersistedAtMs: number | null;
  firstStation: RideStationRef | null;
  lastStation: RideStationRef | null;
  candidateLine: RideTick['line'];
  candidateDirectionName: string | null;
  candidateDistanceMeters: number;
  candidateMaxSpeedKmh: number | null;
};
export type RideRecorderEffect =
  | { type: 'persist'; record: RideRecord }
  | { type: 'close'; record: RideRecord }
  | { type: 'discard'; recordId: string };
type Result = { state: RideRecorderState; effects: RideRecorderEffect[] };

export function createInitialRideRecorderState(): RideRecorderState {
  return {
    phase: 'idle', record: null, candidateSinceMs: null, sawMovingTick: false,
    lostSinceMs: null, stoppedSinceMs: null, lastCommittedAtMs: null,
    lastLocation: null, lastPersistedAtMs: null, firstStation: null, lastStation: null,
    candidateLine: null, candidateDirectionName: null, candidateDistanceMeters: 0,
    candidateMaxSpeedKmh: null,
  };
}

export function toRideTick(entry: EstimationLogEntry): RideTick {
  const { journey, rawLocation, speedState } = entry;
  return {
    timestampMs: entry.timestampMs,
    committed: entry.match !== null && isCommittedRouteLock(entry.match.lockState) && journey.line !== null,
    tracking: journey.status === 'TRACKING',
    line: journey.line ? { id: journey.line.id, name: journey.line.name, operatorName: journey.line.operatorName ?? null } : null,
    directionName: journey.directionName,
    previousStation: journey.previousStation ? { id: journey.previousStation.id, name: journey.previousStation.name } : null,
    isStopped: speedState.isStopped,
    speedKmh: speedState.smoothedSpeedKmh,
    location: rawLocation ? {
      latitude: rawLocation.latitude, longitude: rawLocation.longitude,
      accuracyMeters: rawLocation.accuracyMeters, timestampMs: rawLocation.timestampMs,
    } : null,
  };
}

function applySample(lastLocation: RideRecorderState['lastLocation'], tick: RideTick, config: RideHistoryConfig) {
  const sample = tick.location;
  if (!sample || sample.accuracyMeters > config.maxSampleAccuracyMeters ||
      (lastLocation !== null && sample.timestampMs <= lastLocation.timestampMs)) {
    return { lastLocation, distance: 0 };
  }
  const distance = lastLocation ? haversineDistance(lastLocation.latitude, lastLocation.longitude, sample.latitude, sample.longitude) : 0;
  return {
    lastLocation: { latitude: sample.latitude, longitude: sample.longitude, timestampMs: sample.timestampMs },
    distance: distance > config.maxSampleJumpMeters ? 0 : distance,
  };
}

function startCandidate(tick: RideTick, config: RideHistoryConfig): RideRecorderState {
  return {
    ...createInitialRideRecorderState(), phase: 'candidate', candidateSinceMs: tick.timestampMs,
    candidateLine: tick.line, candidateDirectionName: tick.directionName,
    sawMovingTick: !tick.isStopped, firstStation: tick.previousStation, lastStation: tick.previousStation,
    candidateMaxSpeedKmh: tick.speedKmh, lastCommittedAtMs: tick.timestampMs,
    stoppedSinceMs: tick.isStopped ? tick.timestampMs : null,
    lastLocation: applySample(null, tick, config).lastLocation,
  };
}

function maxSpeed(previous: number | null, current: number | null): number | null {
  return current === null ? previous : previous === null ? current : Math.max(previous, current);
}

function tooShort(record: RideRecord, endedAtMs: number, config: RideHistoryConfig): boolean {
  return endedAtMs - record.startedAtMs < config.minRideDurationMs || record.distanceMeters < config.minRideDistanceMeters;
}

function closeRecord(state: RideRecorderState, record: RideRecord, endedAtMs: number, endReason: RideEndReason, timestampMs: number, config: RideHistoryConfig): Result {
  const closed: RideRecord = { ...record, status: 'closed', endedAtMs, endReason, toStation: state.lastStation, updatedAtMs: timestampMs };
  return {
    state: createInitialRideRecorderState(),
    effects: [tooShort(closed, endedAtMs, config) ? { type: 'discard', recordId: record.id } : { type: 'close', record: closed }],
  };
}

export function reduceRideTick(state: RideRecorderState, tick: RideTick, config: RideHistoryConfig, newId: () => string = createRideId): Result {
  if (state.lastCommittedAtMs !== null && tick.timestampMs <= state.lastCommittedAtMs) return { state, effects: [] };
  if (state.phase === 'idle') {
    return { state: tick.committed && tick.tracking && !tick.isStopped ? startCandidate(tick, config) : { ...state }, effects: [] };
  }
  if (state.phase === 'candidate' && !tick.committed) return { state: createInitialRideRecorderState(), effects: [] };
  if (state.phase === 'candidate' && tick.line?.id !== state.candidateLine?.id) {
    return { state: tick.isStopped ? createInitialRideRecorderState() : startCandidate(tick, config), effects: [] };
  }
  if (state.phase === 'riding' && state.record && tick.committed && tick.line?.id !== state.record.lineId) {
    const result = closeRecord(state, state.record, state.lastCommittedAtMs!, 'transfer', tick.timestampMs, config);
    return { state: tick.isStopped ? result.state : startCandidate(tick, config), effects: result.effects };
  }

  const next = { ...state, stoppedSinceMs: tick.isStopped ? (state.stoppedSinceMs ?? tick.timestampMs) : null };
  if (!tick.committed) {
    next.lostSinceMs = state.lostSinceMs ?? tick.timestampMs;
    if (next.record && next.stoppedSinceMs !== null && tick.timestampMs - next.stoppedSinceMs >= config.stoppedEndMs) {
      return closeRecord(next, next.record, next.stoppedSinceMs, 'stopped', tick.timestampMs, config);
    }
    if (next.record && tick.timestampMs - next.lostSinceMs >= config.routeLostEndMs) {
      return closeRecord(next, next.record, next.lastCommittedAtMs!, 'route-lost', tick.timestampMs, config);
    }
    return { state: next, effects: [] };
  }

  next.lastCommittedAtMs = tick.timestampMs;
  next.lostSinceMs = null;
  next.firstStation = next.firstStation ?? tick.previousStation;
  next.lastStation = tick.previousStation ?? next.lastStation;
  const sample = applySample(state.lastLocation, tick, config);
  next.lastLocation = sample.lastLocation;

  if (next.phase === 'candidate') {
    next.sawMovingTick ||= !tick.isStopped;
    next.candidateDistanceMeters += sample.distance;
    next.candidateMaxSpeedKmh = maxSpeed(next.candidateMaxSpeedKmh, tick.speedKmh);
    if (next.candidateLine && next.candidateSinceMs !== null && next.sawMovingTick && tick.timestampMs - next.candidateSinceMs >= config.startConfirmMs) {
      // The prescribed state retains the first and last candidate stations only.
      const passedStations = next.firstStation ? [next.firstStation] : [];
      if (next.lastStation && next.lastStation.id !== next.firstStation?.id) passedStations.push(next.lastStation);
      next.phase = 'riding';
      next.record = {
        recordVersion: 1, id: newId(), status: 'open', lineId: next.candidateLine.id,
        lineName: next.candidateLine.name, operatorName: next.candidateLine.operatorName,
        directionName: next.candidateDirectionName, fromStation: next.firstStation, toStation: null,
        passedStations, startedAtMs: next.candidateSinceMs, endedAtMs: null, endReason: null,
        distanceMeters: next.candidateDistanceMeters, maxSpeedKmh: next.candidateMaxSpeedKmh, updatedAtMs: tick.timestampMs,
      };
      next.lastPersistedAtMs = tick.timestampMs;
      return { state: next, effects: [{ type: 'persist', record: next.record }] };
    }
    return { state: next, effects: [] };
  }

  const record = next.record!;
  const stationChanged = tick.previousStation !== null && tick.previousStation.id !== record.passedStations.at(-1)?.id;
  next.record = {
    ...record, fromStation: record.fromStation ?? next.firstStation,
    passedStations: stationChanged ? [...record.passedStations, tick.previousStation!] : [...record.passedStations],
    distanceMeters: record.distanceMeters + sample.distance,
    maxSpeedKmh: maxSpeed(record.maxSpeedKmh, tick.speedKmh),
  };
  if (next.stoppedSinceMs !== null && tick.timestampMs - next.stoppedSinceMs >= config.stoppedEndMs) {
    return closeRecord(next, next.record, next.stoppedSinceMs, 'stopped', tick.timestampMs, config);
  }
  if (stationChanged || next.lastPersistedAtMs === null || tick.timestampMs - next.lastPersistedAtMs >= config.persistIntervalMs) {
    next.record = { ...next.record, updatedAtMs: tick.timestampMs };
    next.lastPersistedAtMs = tick.timestampMs;
    return { state: next, effects: [{ type: 'persist', record: next.record }] };
  }
  return { state: next, effects: [] };
}

export function finalizeDanglingRecord(record: RideRecord, config: RideHistoryConfig): RideRecord | null {
  if (tooShort(record, record.updatedAtMs, config)) return null;
  return {
    ...record, status: 'closed', endedAtMs: record.updatedAtMs, endReason: 'app-restart',
    toStation: record.toStation ?? record.passedStations.at(-1) ?? null,
    passedStations: [...record.passedStations],
  };
}
