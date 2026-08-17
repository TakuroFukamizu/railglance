import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample } from '../models/location';
import {
  RailwayLine,
  RouteCandidateScore,
  RouteChallengerState,
  RouteHealth,
  RouteLockEvent,
  RouteLockState,
  RouteMatch,
  RouteSwitchReason,
  TrackSegment,
  WindowRouteScore,
} from '../models/railway';
import { computeTrajectory, resolveEffectiveHeading, trimLocationHistory } from '../geo/trajectory';
import { scoreCandidate } from './candidate-scorer';
import { calculateConfidence } from './confidence';
import { evaluateRouteHealth, headingDifferenceOrNull, RouteObservation } from './route-health';
import { scoreRoutesOverWindow } from './window-scorer';

export interface RailwayDatabaseReader {
  findSegmentsNear(latitude: number, longitude: number, radiusMeters: number): Promise<TrackSegment[]>;
  getLine(lineId: string): Promise<RailwayLine | undefined>;
}

type PendingLeader = {
  lineId: string;
  segmentId: string;
  firstSeenAtMs: number;
  consecutiveCount: number;
};

export class MapMatcher {
  private currentMatch: RouteCandidateScore | null = null;
  private lockState: RouteLockState = 'UNRESOLVED';
  private history: LocationSample[] = [];
  private observations: RouteObservation[] = [];
  private challenger: RouteChallengerState | null = null;
  private pendingLeader: PendingLeader | null = null;
  private suspiciousSinceMs: number | null = null;
  private manualReacquireActive = false;
  private manualLockUntilMs: number | null = null;
  private lastSwitchReason: RouteSwitchReason | null = null;
  private pendingEvents: RouteLockEvent[] = [];
  private lastCandidates: RouteCandidateScore[] = [];
  private healthLowSinceMs: number | null = null;

  constructor(
    private db: RailwayDatabaseReader,
    private config: TrackingConfig
  ) {}

  public getLockState(): RouteLockState {
    return this.lockState;
  }

  public startManualReacquire(nowMs: number): void {
    this.manualReacquireActive = true;
    this.manualLockUntilMs = null;
    this.pendingLeader = null;
    this.challenger = null;
    this.suspiciousSinceMs = null;
    this.lastSwitchReason = 'manual-reacquire';
    this.pushEvent('manual-reacquire', 'manual-reacquire', {
      fromState: this.lockState,
      previousLineId: this.currentMatch?.line.id ?? null,
      previousSegmentId: this.currentMatch?.segment.id ?? null,
    });
    this.transitionTo('REACQUIRING', nowMs, 'manual-reacquire');
    this.currentMatch = null;
  }

  public lockSelectedRoute(segmentId: string, nowMs: number): boolean {
    const fromHistory = this.lastCandidates.find((candidate) => candidate.segment.id === segmentId)
      ?? (this.currentMatch?.segment.id === segmentId ? this.currentMatch : null);
    if (!fromHistory) return false;

    this.manualReacquireActive = false;
    this.manualLockUntilMs = nowMs + this.config.routeManualLockDurationMs;
    this.currentMatch = fromHistory;
    this.pendingLeader = null;
    this.challenger = null;
    this.suspiciousSinceMs = null;
    this.lastSwitchReason = 'manual-selection';
    this.pushEvent('manual-route-lock', 'manual-selection', {
      lineId: fromHistory.line.id,
      segmentId: fromHistory.segment.id,
      score: fromHistory.totalScore,
    });
    this.transitionTo('MANUAL_LOCK', nowMs, 'manual-selection');
    return true;
  }

  public unlockManualRoute(nowMs: number): void {
    this.pushEvent('manual-route-unlock', undefined, {
      fromLineId: this.currentMatch?.line.id ?? null,
      fromSegmentId: this.currentMatch?.segment.id ?? null,
    });
    this.manualReacquireActive = false;
    this.manualLockUntilMs = null;
    this.currentMatch = null;
    this.pendingLeader = null;
    this.challenger = null;
    this.suspiciousSinceMs = null;
    this.healthLowSinceMs = null;
    this.observations = [];
    this.lastSwitchReason = null;
    this.transitionTo('UNRESOLVED', nowMs);
  }

  public forceLockForTests(candidate: RouteCandidateScore): void {
    this.currentMatch = candidate;
    this.lockState = 'LOCKED';
    this.manualReacquireActive = false;
    this.lastCandidates = [candidate];
    this.lastSwitchReason = 'initial-lock';
  }

  public async match(sample: LocationSample): Promise<RouteMatch | null> {
    const eventsAtStart = this.pendingEvents.length;

    if (sample.accuracyMeters > this.config.maxGpsAccuracyMeters) {
      return this.buildMatch(sample, [], null, null, eventsAtStart);
    }

    this.history.push(sample);
    this.history = trimLocationHistory(
      this.history,
      sample.timestampMs,
      Math.max(this.config.routeWindowMs, this.config.routeTrajectoryWindowMs)
    );

    if (this.lockState === 'MANUAL_LOCK' && this.manualLockUntilMs !== null && sample.timestampMs >= this.manualLockUntilMs) {
      this.unlockManualRoute(sample.timestampMs);
    }

    const segments = await this.db.findSegmentsNear(
      sample.latitude,
      sample.longitude,
      this.config.routeSearchRadiusMeters
    );

    if (segments.length === 0) {
      return this.handleNoCandidates(sample, eventsAtStart);
    }

    const stopped = (sample.speedMps ?? 0) * 3.6 <= this.config.stopSpeedThresholdKmh;
    const trajectory = computeTrajectory(this.history, sample.timestampMs, this.config, stopped);
    const effectiveHeading = resolveEffectiveHeading(trajectory, sample);

    const candidateScores: RouteCandidateScore[] = [];
    for (const segment of segments) {
      const line = await this.db.getLine(segment.lineId);
      if (!line) continue;
      candidateScores.push(
        scoreCandidate({
          sample,
          segment,
          line,
          previousSegment: this.currentMatch?.segment ?? null,
          nearbySegments: segments,
          lockState: this.lockState,
          effectiveHeadingDegrees: effectiveHeading,
          config: this.config,
        })
      );
    }

    if (candidateScores.length === 0) {
      return this.handleNoCandidates(sample, eventsAtStart);
    }

    candidateScores.sort((a, b) => b.totalScore - a.totalScore);
    this.lastCandidates = candidateScores.slice(0, 8);

    const topCandidate = candidateScores[0];
    const secondCandidate = this.nextDifferentLine(candidateScores, topCandidate.line.id);
    const scoreMargin = topCandidate.totalScore - (secondCandidate?.totalScore ?? 0);
    const rescoredCurrent = this.rescoreCurrent(candidateScores);

    this.recordObservation(sample, rescoredCurrent ?? (this.isCurrentLine(topCandidate) ? topCandidate : null));
    this.updateChallenger(topCandidate, rescoredCurrent, scoreMargin, sample.timestampMs);

    const health = this.lockState === 'UNRESOLVED'
      ? null
      : evaluateRouteHealth(
          this.observations,
          rescoredCurrent,
          this.challenger && !this.isCurrentLine(topCandidate) ? this.challenger.latestMargin : null,
          this.config
        );

    const windowScores = this.shouldScoreWindow()
      ? scoreRoutesOverWindow(this.history, this.groupRoutes(candidateScores), this.config)
      : [];

    this.advanceState({
      sample,
      topCandidate,
      secondCandidate,
      scoreMargin,
      rescoredCurrent,
      health,
      windowScores,
      stopped,
    });

    return this.buildMatch(sample, candidateScores, health, windowScores, eventsAtStart, {
      scoreMargin,
      currentScore: this.currentMatch?.totalScore ?? null,
      rescoredCurrentScore: rescoredCurrent?.totalScore ?? null,
      trajectoryHeadingDegrees: trajectory.headingDegrees,
    });
  }

  public reset(): void {
    this.currentMatch = null;
    this.lockState = 'UNRESOLVED';
    this.history = [];
    this.observations = [];
    this.challenger = null;
    this.pendingLeader = null;
    this.suspiciousSinceMs = null;
    this.manualReacquireActive = false;
    this.manualLockUntilMs = null;
    this.lastSwitchReason = null;
    this.pendingEvents = [];
    this.lastCandidates = [];
    this.healthLowSinceMs = null;
  }

  private async handleNoCandidates(sample: LocationSample, eventsAtStart: number): Promise<RouteMatch | null> {
    if (this.currentMatch && this.lockState !== 'UNRESOLVED' && this.lockState !== 'MANUAL_LOCK') {
      this.recordLostObservation(sample);
      if (this.lockState === 'LOCKED') {
        this.enterSuspicious(sample.timestampMs, 'current-route-lost');
      } else if (this.lockState === 'SUSPICIOUS') {
        this.maybeEnterReacquiring(sample.timestampMs);
      } else if (this.lockState === 'REACQUIRING') {
        this.pushEvent('route-lost', 'current-route-lost', {
          lineId: this.currentMatch.line.id,
          segmentId: this.currentMatch.segment.id,
        });
        this.currentMatch = null;
        this.transitionTo('UNRESOLVED', sample.timestampMs, 'current-route-lost');
      }
    }
    return this.buildMatch(sample, [], null, [], eventsAtStart);
  }

  private advanceState(input: {
    sample: LocationSample;
    topCandidate: RouteCandidateScore;
    secondCandidate: RouteCandidateScore | null;
    scoreMargin: number;
    rescoredCurrent: RouteCandidateScore | null;
    health: RouteHealth | null;
    windowScores: WindowRouteScore[];
    stopped: boolean;
  }): void {
    const { sample, topCandidate, scoreMargin, rescoredCurrent, health, windowScores } = input;

    if (this.lockState === 'MANUAL_LOCK') {
      if (rescoredCurrent) this.currentMatch = rescoredCurrent;
      return;
    }

    if (this.lockState === 'UNRESOLVED') {
      this.considerInitialLock(topCandidate, scoreMargin, sample.timestampMs);
      return;
    }

    if (rescoredCurrent) {
      this.adoptSameLineProgress(rescoredCurrent, topCandidate);
    } else if (this.currentMatch) {
      this.recordLostObservation(sample);
    }

    if (this.lockState === 'LOCKED') {
      if (!rescoredCurrent) {
        this.enterSuspicious(sample.timestampMs, 'current-route-lost');
        return;
      }
      if (this.shouldEnterSuspicious(health, sample.timestampMs)) {
        this.enterSuspicious(sample.timestampMs, this.challengerDominant() ? 'challenger-dominant' : 'route-health-low');
      }
      return;
    }

    if (this.lockState === 'SUSPICIOUS') {
      if (this.shouldRecoverToLocked(health, scoreMargin, topCandidate)) {
        if (rescoredCurrent) this.currentMatch = rescoredCurrent;
        this.exitSuspicion();
        this.transitionTo('LOCKED', sample.timestampMs);
        return;
      }
      if (!this.isCurrentLine(topCandidate) && scoreMargin >= this.config.routeChallengerMinMargin) {
        this.trackPendingLeader(topCandidate, scoreMargin, sample.timestampMs, true);
      }
      if (!this.maybeEnterReacquiring(sample.timestampMs)) return;
    }

    if (this.lockState === 'REACQUIRING') {
      if (!this.currentMatch) {
        this.considerInitialLock(topCandidate, scoreMargin, sample.timestampMs);
        return;
      }
      this.considerReacquireLock(topCandidate, scoreMargin, health, windowScores, sample);
    }
  }

  private considerInitialLock(topCandidate: RouteCandidateScore, scoreMargin: number, nowMs: number): void {
    const minScore = this.config.routeInitialLockMinScore;
    const minMargin = this.config.routeInitialLockMinMargin;
    const neededCount = this.lockState === 'REACQUIRING'
      ? this.config.routeRelockConsecutiveCount
      : this.config.routeInitialLockConsecutiveCount;
    const neededMs = this.lockState === 'REACQUIRING'
      ? this.config.routeRelockMinimumMs
      : this.config.routeInitialLockMinimumMs;
    const qualifies = topCandidate.totalScore >= minScore && scoreMargin >= minMargin;

    if (!qualifies) {
      this.pendingLeader = null;
      return;
    }

    if (this.pendingLeader && this.pendingLeader.lineId === topCandidate.line.id) {
      this.pendingLeader.consecutiveCount += 1;
      this.pendingLeader.segmentId = topCandidate.segment.id;
    } else {
      this.pendingLeader = {
        lineId: topCandidate.line.id,
        segmentId: topCandidate.segment.id,
        firstSeenAtMs: nowMs,
        consecutiveCount: 1,
      };
    }

    const duration = nowMs - this.pendingLeader.firstSeenAtMs;
    if (this.pendingLeader.consecutiveCount >= neededCount && duration >= neededMs) {
      const reason: RouteSwitchReason = this.lockState === 'REACQUIRING' ? 'manual-reacquire' : 'initial-lock';
      this.currentMatch = topCandidate;
      this.pendingLeader = null;
      this.lastSwitchReason = reason;
      this.pushEvent('route-lock', reason, {
        lineId: topCandidate.line.id,
        segmentId: topCandidate.segment.id,
        score: topCandidate.totalScore,
        margin: scoreMargin,
      });
      this.manualReacquireActive = false;
      this.transitionTo('LOCKED', nowMs, reason);
    }
  }

  private considerReacquireLock(
    topCandidate: RouteCandidateScore,
    scoreMargin: number,
    health: RouteHealth | null,
    windowScores: WindowRouteScore[],
    sample: LocationSample
  ): void {
    const nowMs = sample.timestampMs;
    const windowLeader = windowScores[0] ?? null;
    const windowSecond = windowScores[1] ?? null;
    const windowMargin = windowLeader && windowSecond ? windowLeader.totalScore - windowSecond.totalScore : 1;
    const windowAgrees =
      windowLeader !== null &&
      windowLeader.lineId === topCandidate.line.id &&
      (windowScores.length < 2 || windowMargin >= 0.05);

    const currentLineStillBest = this.currentMatch !== null && this.isCurrentLine(topCandidate);
    const healthRecovered = (health?.total ?? 0) >= this.config.routeSuspiciousHealthThreshold + 0.15;

    if (currentLineStillBest && healthRecovered && !this.manualReacquireActive) {
      this.adoptSameLineProgress(this.rescoreCurrent([topCandidate]) ?? topCandidate, topCandidate);
      this.finishReacquireLock(topCandidate, nowMs);
      return;
    }

    const accuracyOk = sample.accuracyMeters <= Math.max(50, this.config.routeMinimumAccuracyMeters * 2);
    const trajectoryOk = this.history.length >= this.config.routeWindowMinSamples;
    const evidenceOk = accuracyOk || trajectoryOk;
    const healthContradicts =
      health === null || health.total < this.config.routeSuspiciousHealthThreshold || this.manualReacquireActive;
    const triple =
      evidenceOk &&
      this.challengerDominant() &&
      healthContradicts &&
      scoreMargin >= this.config.routeChallengerMinMargin;

    const windowSupportedSwitch =
      evidenceOk &&
      healthContradicts &&
      windowAgrees &&
      !this.isCurrentLine(topCandidate) &&
      scoreMargin >= this.config.routeChallengerMinMargin &&
      topCandidate.totalScore >= this.config.routeInitialLockMinScore;

    const candidate = triple || windowSupportedSwitch ? topCandidate : null;
    if (!candidate) {
      this.trackPendingLeader(topCandidate, scoreMargin, nowMs, false);
      return;
    }

    this.trackPendingLeader(candidate, scoreMargin, nowMs, true);
    const pending = this.pendingLeader;
    if (!pending || pending.lineId !== candidate.line.id) return;

    const duration = nowMs - pending.firstSeenAtMs;
    const neededCount = this.manualReacquireActive
      ? this.config.routeRelockConsecutiveCount
      : this.config.routeChallengerConsecutiveCount;
    const neededMs = this.manualReacquireActive
      ? this.config.routeRelockMinimumMs
      : this.config.routeChallengerMinimumMs;

    if (pending.consecutiveCount >= neededCount && duration >= neededMs) {
      const reason: RouteSwitchReason = this.currentMatch && this.currentMatch.line.id !== candidate.line.id
        ? 'challenger-dominant'
        : this.manualReacquireActive
          ? 'manual-reacquire'
          : 'route-health-low';
      this.switchCurrent(candidate, nowMs, reason);
      this.finishReacquireLock(candidate, nowMs, reason);
    }
  }

  private finishReacquireLock(candidate: RouteCandidateScore, nowMs: number, reason?: RouteSwitchReason): void {
    this.manualReacquireActive = false;
    this.suspiciousSinceMs = null;
    this.pendingLeader = null;
    this.challenger = null;
    if (reason) this.lastSwitchReason = reason;
    this.pushEvent('route-lock', reason, {
      lineId: candidate.line.id,
      segmentId: candidate.segment.id,
      score: candidate.totalScore,
    });
    this.transitionTo('LOCKED', nowMs, reason);
  }

  private switchCurrent(candidate: RouteCandidateScore, nowMs: number, reason: RouteSwitchReason): void {
    this.pushEvent('route-switch', reason, {
      fromLineId: this.currentMatch?.line.id ?? null,
      fromSegmentId: this.currentMatch?.segment.id ?? null,
      toLineId: candidate.line.id,
      toSegmentId: candidate.segment.id,
      score: candidate.totalScore,
      atMs: nowMs,
    });
    this.currentMatch = candidate;
    this.observations = [];
  }

  private adoptSameLineProgress(rescoredCurrent: RouteCandidateScore, topCandidate: RouteCandidateScore): void {
    if (this.currentMatch && topCandidate.line.id === this.currentMatch.line.id) {
      this.currentMatch = topCandidate;
      return;
    }
    this.currentMatch = rescoredCurrent;
  }

  private shouldEnterSuspicious(health: RouteHealth | null, nowMs: number): boolean {
    if (this.challengerDominant()) return true;
    if (!health) {
      this.healthLowSinceMs = null;
      return false;
    }
    if (health.total < this.config.routeSuspiciousHealthThreshold) {
      if (this.healthLowSinceMs === null) this.healthLowSinceMs = nowMs;
      return nowMs - this.healthLowSinceMs >= this.config.routeSuspiciousMinimumMs;
    }
    this.healthLowSinceMs = null;
    return false;
  }

  private shouldRecoverToLocked(
    health: RouteHealth | null,
    scoreMargin: number,
    topCandidate: RouteCandidateScore
  ): boolean {
    if (!this.currentMatch || !this.isCurrentLine(topCandidate)) return false;
    if ((health?.total ?? 0) < this.config.routeSuspiciousHealthThreshold + 0.12) return false;
    return scoreMargin >= 0 || !this.challenger;
  }

  private enterSuspicious(nowMs: number, reason: RouteSwitchReason): void {
    if (this.lockState === 'SUSPICIOUS') return;
    this.suspiciousSinceMs = nowMs;
    this.lastSwitchReason = reason;
    this.pushEvent('route-suspicious', reason, {
      lineId: this.currentMatch?.line.id ?? null,
      health: this.observations.length,
    });
    this.transitionTo('SUSPICIOUS', nowMs, reason);
  }

  private maybeEnterReacquiring(nowMs: number): boolean {
    if (this.suspiciousSinceMs === null) this.suspiciousSinceMs = nowMs;
    if (nowMs - this.suspiciousSinceMs < this.config.routeReacquireMinimumMs) return false;
    this.pushEvent('route-reacquire-start', this.challenger ? 'challenger-dominant' : 'route-health-low', {
      lineId: this.currentMatch?.line.id ?? null,
      challengerLineId: this.challenger?.lineId ?? null,
    });
    this.transitionTo('REACQUIRING', nowMs, this.challenger ? 'challenger-dominant' : 'route-health-low');
    return true;
  }

  private exitSuspicion(): void {
    this.suspiciousSinceMs = null;
    this.challenger = null;
  }

  private challengerDominant(): boolean {
    if (!this.challenger || !this.currentMatch) return false;
    if (this.challenger.lineId === this.currentMatch.line.id) return false;
    const duration = this.challenger.lastSeenAtMs - this.challenger.firstSeenAtMs;
    return (
      this.challenger.latestMargin >= this.config.routeChallengerMinMargin &&
      this.challenger.consecutiveWins >= this.config.routeChallengerConsecutiveCount &&
      duration >= this.config.routeChallengerMinimumMs
    );
  }

  private updateChallenger(
    topCandidate: RouteCandidateScore,
    rescoredCurrent: RouteCandidateScore | null,
    scoreMargin: number,
    nowMs: number
  ): void {
    if (!this.currentMatch || this.isCurrentLine(topCandidate)) {
      if (this.challenger && nowMs - this.challenger.lastSeenAtMs > this.config.routeChallengerMinimumMs) {
        this.challenger = null;
      }
      return;
    }

    const comparedMargin = rescoredCurrent
      ? topCandidate.totalScore - rescoredCurrent.totalScore
      : scoreMargin;

    if (this.challenger && this.challenger.lineId === topCandidate.line.id) {
      this.challenger.consecutiveWins += 1;
      this.challenger.lastSeenAtMs = nowMs;
      this.challenger.latestScore = topCandidate.totalScore;
      this.challenger.latestMargin = comparedMargin;
      this.challenger.segmentId = topCandidate.segment.id;
      this.challenger.routeId = topCandidate.segment.routeId ?? null;
      return;
    }

    this.challenger = {
      segmentId: topCandidate.segment.id,
      routeId: topCandidate.segment.routeId ?? null,
      lineId: topCandidate.line.id,
      consecutiveWins: 1,
      firstSeenAtMs: nowMs,
      lastSeenAtMs: nowMs,
      latestScore: topCandidate.totalScore,
      latestMargin: comparedMargin,
    };
  }

  private trackPendingLeader(
    candidate: RouteCandidateScore,
    _scoreMargin: number,
    nowMs: number,
    qualifies: boolean
  ): void {
    if (!qualifies) {
      this.pendingLeader = null;
      return;
    }
    if (this.pendingLeader && this.pendingLeader.lineId === candidate.line.id) {
      this.pendingLeader.consecutiveCount += 1;
      this.pendingLeader.segmentId = candidate.segment.id;
      return;
    }
    this.pendingLeader = {
      lineId: candidate.line.id,
      segmentId: candidate.segment.id,
      firstSeenAtMs: nowMs,
      consecutiveCount: 1,
    };
  }

  private rescoreCurrent(candidateScores: RouteCandidateScore[]): RouteCandidateScore | null {
    if (!this.currentMatch) return null;
    return (
      candidateScores.find((candidate) => candidate.segment.id === this.currentMatch?.segment.id) ??
      candidateScores.find((candidate) => candidate.line.id === this.currentMatch?.line.id) ??
      null
    );
  }

  private isCurrentLine(candidate: RouteCandidateScore): boolean {
    return this.currentMatch !== null && candidate.line.id === this.currentMatch.line.id;
  }

  private nextDifferentLine(
    candidates: RouteCandidateScore[],
    lineId: string
  ): RouteCandidateScore | null {
    return candidates.find((candidate) => candidate.line.id !== lineId) ?? candidates[1] ?? null;
  }

  private recordObservation(sample: LocationSample, scored: RouteCandidateScore | null): void {
    if (!scored) return;
    this.observations.push({
      timestampMs: sample.timestampMs,
      lineId: scored.line.id,
      segmentId: scored.segment.id,
      routeId: scored.segment.routeId ?? null,
      distanceMeters: scored.distanceMeters,
      headingDifferenceDegrees: headingDifferenceOrNull(scored.effectiveHeadingDegrees ?? sample.headingDegrees, scored.bearingDegrees),
      trackPositionMeters: scored.trackPositionMeters ?? null,
      stationSequence: stationSequenceHint(scored.segment),
    });
    this.observations = this.observations.filter(
      (obs) => sample.timestampMs - obs.timestampMs <= this.config.routeWindowMs
    );
  }

  private recordLostObservation(sample: LocationSample): void {
    if (!this.currentMatch) return;
    this.observations.push({
      timestampMs: sample.timestampMs,
      lineId: this.currentMatch.line.id,
      segmentId: this.currentMatch.segment.id,
      routeId: this.currentMatch.segment.routeId ?? null,
      distanceMeters: this.config.routeSearchRadiusMeters,
      headingDifferenceDegrees: 90,
      trackPositionMeters: null,
      stationSequence: null,
    });
    this.observations = this.observations.filter(
      (obs) => sample.timestampMs - obs.timestampMs <= this.config.routeWindowMs
    );
  }

  private shouldScoreWindow(): boolean {
    return this.lockState === 'REACQUIRING' || this.manualReacquireActive || this.lockState === 'SUSPICIOUS';
  }

  private groupRoutes(candidates: RouteCandidateScore[]) {
    const byKey = new Map<string, { routeId: string; line: RailwayLine; segments: TrackSegment[] }>();
    for (const candidate of candidates) {
      const routeId = candidate.segment.routeId ?? `line:${candidate.line.id}`;
      const existing = byKey.get(routeId);
      if (existing) {
        if (!existing.segments.some((segment) => segment.id === candidate.segment.id)) {
          existing.segments.push(candidate.segment);
        }
        continue;
      }
      byKey.set(routeId, {
        routeId,
        line: candidate.line,
        segments: [candidate.segment],
      });
    }
    return [...byKey.values()];
  }

  private transitionTo(state: RouteLockState, _nowMs: number, reason?: RouteSwitchReason): void {
    if (this.lockState === state) {
      if (reason) this.lastSwitchReason = reason;
      return;
    }
    this.lockState = state;
    if (reason) this.lastSwitchReason = reason;
  }

  private pushEvent(
    type: RouteLockEvent['type'],
    reason: RouteSwitchReason | undefined,
    data: RouteLockEvent['data']
  ): void {
    this.pendingEvents.push({
      type,
      reason,
      data: {
        ...data,
        lockState: this.lockState,
      },
    });
  }

  private consumeEvents(fromIndex: number): RouteLockEvent[] {
    const events = this.pendingEvents.slice(fromIndex);
    this.pendingEvents = [];
    return events;
  }

  private buildMatch(
    sample: LocationSample,
    candidates: RouteCandidateScore[],
    health: RouteHealth | null,
    windowScores: WindowRouteScore[] | null,
    eventsAtStart: number,
    extras: Partial<RouteMatch> = {}
  ): RouteMatch | null {
    const selected = this.currentMatch ?? candidates[0] ?? null;
    if (!selected) {
      this.consumeEvents(eventsAtStart);
      return null;
    }

    const second = this.nextDifferentLine(candidates, selected.line.id);
    let confidence = calculateConfidence(selected, second);
    if (this.lockState === 'UNRESOLVED' || (this.lockState === 'REACQUIRING' && this.manualReacquireActive)) {
      confidence = Math.min(confidence, 0.45);
    } else if (this.lockState === 'MANUAL_LOCK') {
      confidence = Math.max(confidence, 0.9);
    }

    const showSelectedRoute =
      this.currentMatch !== null &&
      (this.lockState === 'LOCKED' ||
        this.lockState === 'SUSPICIOUS' ||
        this.lockState === 'MANUAL_LOCK' ||
        (this.lockState === 'REACQUIRING' && !this.manualReacquireActive));

    const manualLockAway =
      this.lockState === 'MANUAL_LOCK' &&
      selected.distanceMeters > this.config.routeManualLockMaxDistanceMeters;

    const scoreMargin =
      extras.scoreMargin ??
      (candidates.length > 0 ? candidates[0].totalScore - (candidates[1]?.totalScore ?? 0) : 0);

    return {
      selectedLine: selected.line,
      selectedSegment: selected.segment,
      confidence,
      candidates: candidates.slice(0, 5),
      timestampMs: sample.timestampMs,
      lockState: this.lockState,
      routeHealth: health,
      challenger: this.challenger,
      scoreMargin,
      currentScore: extras.currentScore ?? this.currentMatch?.totalScore ?? null,
      rescoredCurrentScore: extras.rescoredCurrentScore ?? null,
      trajectoryHeadingDegrees: extras.trajectoryHeadingDegrees ?? null,
      switchReason: this.lastSwitchReason,
      manualLockAway,
      showSelectedRoute,
      windowScores: windowScores ?? [],
      lockEvents: this.consumeEvents(eventsAtStart),
    };
  }
}

function stationSequenceHint(segment: TrackSegment): number | null {
  const from = Number.parseInt(segment.fromStationId.replace(/\D+/g, ''), 10);
  return Number.isFinite(from) ? from : null;
}
