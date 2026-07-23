import { TrackingConfig } from '../../config/tracking-config';
import { LocationSample } from '../models/location';
import { RailwayLine, RouteCandidateScore, RouteMatch, TrackSegment } from '../models/railway';
import { scoreCandidate } from './candidate-scorer';
import { calculateConfidence } from './confidence';

export interface RailwayDatabaseReader {
  findSegmentsNear(latitude: number, longitude: number, radiusMeters: number): Promise<TrackSegment[]>;
  getLine(lineId: string): Promise<RailwayLine | undefined>;
}

export class MapMatcher {
  private currentMatch: RouteCandidateScore | null = null;
  private pendingCandidateId: string | null = null;
  private pendingCount = 0;
  private pendingFirstSeenTimeMs = 0;

  constructor(
    private db: RailwayDatabaseReader,
    private config: TrackingConfig
  ) {}

  public async match(sample: LocationSample): Promise<RouteMatch | null> {
    if (sample.accuracyMeters > this.config.maxGpsAccuracyMeters) {
      return null;
    }

    const segments = await this.db.findSegmentsNear(
      sample.latitude,
      sample.longitude,
      this.config.routeSearchRadiusMeters
    );

    if (segments.length === 0) {
      return null;
    }

    const candidateScores: RouteCandidateScore[] = [];
    const prevSegId = this.currentMatch?.segment.id ?? null;

    for (const seg of segments) {
      const line = await this.db.getLine(seg.lineId);
      if (!line) continue;
      const score = scoreCandidate(sample, seg, line, prevSegId, this.config);
      candidateScores.push(score);
    }

    if (candidateScores.length === 0) {
      return null;
    }

    // Sort candidates descending by total score
    candidateScores.sort((a, b) => b.totalScore - a.totalScore);

    const topCandidate = candidateScores[0];
    const secondCandidate = candidateScores[1] ?? null;

    // Apply Hysteresis for route switching
    if (this.currentMatch === null) {
      this.currentMatch = topCandidate;
    } else if (topCandidate.segment.id !== this.currentMatch.segment.id) {
      // Different segment is top candidate
      if (this.pendingCandidateId === topCandidate.segment.id) {
        this.pendingCount++;
        const duration = sample.timestampMs - this.pendingFirstSeenTimeMs;

        const isConsecutive = this.pendingCount >= this.config.routeSwitchConsecutiveCount;
        const isTimeMet = duration >= this.config.routeSwitchMinimumMs;
        const scoreDifferenceSignificant = topCandidate.totalScore - this.currentMatch.totalScore > 15;

        if ((isConsecutive || isTimeMet) && scoreDifferenceSignificant) {
          this.currentMatch = topCandidate;
          this.pendingCandidateId = null;
          this.pendingCount = 0;
        }
      } else {
        this.pendingCandidateId = topCandidate.segment.id;
        this.pendingCount = 1;
        this.pendingFirstSeenTimeMs = sample.timestampMs;
      }
    } else {
      // Top candidate is still current match
      this.currentMatch = topCandidate;
      this.pendingCandidateId = null;
      this.pendingCount = 0;
    }

    const confidence = calculateConfidence(this.currentMatch, secondCandidate);

    return {
      selectedLine: this.currentMatch.line,
      selectedSegment: this.currentMatch.segment,
      confidence,
      candidates: candidateScores.slice(0, 5), // top 5
      timestampMs: sample.timestampMs,
    };
  }

  public reset(): void {
    this.currentMatch = null;
    this.pendingCandidateId = null;
    this.pendingCount = 0;
    this.pendingFirstSeenTimeMs = 0;
  }
}
