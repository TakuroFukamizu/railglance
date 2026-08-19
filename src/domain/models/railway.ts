import { DataProvenance } from './provenance';

export type RailwayLine = {
  id: string;
  operatorId: string;
  operatorName?: string;
  name: string;
  shortName?: string;
  directionAName?: string;
  directionBName?: string;
  provenance?: DataProvenance[];
};

export type RailwayRoute = {
  id: string;
  lineId: string;
  direction: TravelDirection;
  stationIds: string[];
  segmentIds: string[];
  totalLengthMeters: number;
  provenance?: DataProvenance[];
};

export type Station = {
  id: string;
  lineId: string;
  name: string;
  sequence: number;
  latitude: number;
  longitude: number;
  routeOffsetMeters?: number;
  provenance?: DataProvenance[];
};

export type TrackSegment = {
  id: string;
  lineId: string;
  routeId?: string;
  fromStationId: string;
  toStationId: string;
  coordinates: Array<[number, number]>; // [latitude, longitude]
  lengthMeters?: number;
  startOffsetMeters?: number;
  cumulativeDistanceMeters?: number;
  previousSegmentIds?: string[];
  nextSegmentIds?: string[];
  provenance?: DataProvenance[];
};

export type DatasetMetadata = {
  version: string;
  schemaVersion: string;
  generatedAt: string;
  area: string;
  licensing?: {
    sources: Array<{
      sourceId: string;
      attributionText: string;
      licenseId: string;
    }>;
  };
};

export type TravelDirection = 'UP' | 'DOWN' | 'DIRECTION_A' | 'DIRECTION_B' | 'UNKNOWN';

export function routeIdentityKey(segment: TrackSegment): string {
  return segment.routeId ?? `line:${segment.lineId}`;
}

export type RouteLockState =
  | 'UNRESOLVED'
  | 'LOCKED'
  | 'SUSPICIOUS'
  | 'REACQUIRING'
  | 'MANUAL_LOCK';

export type RouteSwitchReason =
  | 'initial-lock'
  | 'challenger-dominant'
  | 'route-health-low'
  | 'manual-selection'
  | 'manual-reacquire'
  | 'current-route-lost';

export type RouteLockEventType =
  | 'route-lock'
  | 'route-suspicious'
  | 'route-reacquire-start'
  | 'route-switch'
  | 'manual-reacquire'
  | 'manual-route-lock'
  | 'manual-route-unlock'
  | 'route-lost';

export type ContinuityKind =
  | 'same-segment'
  | 'adjacent-segment'
  | 'reachable-same-route'
  | 'same-line-disconnected'
  | 'unrelated';

export type RouteHealth = {
  distanceConsistency: number;
  headingConsistency: number;
  trajectoryConsistency: number;
  stationSequenceConsistency: number;
  topologyConsistency: number;
  progressConsistency: number;
  challengerDominance: number;
  total: number;
};

export type RouteChallengerState = {
  segmentId: string;
  routeId: string | null;
  lineId: string;
  consecutiveWins: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  latestScore: number;
  latestMargin: number;
};

export type WindowRouteScore = {
  routeId: string;
  lineId: string;
  lineName: string;
  meanDistanceScore: number;
  headingConsistencyScore: number;
  progressMonotonicityScore: number;
  stationSequenceScore: number;
  topologyScore: number;
  totalScore: number;
};

export type RouteLockEvent = {
  type: RouteLockEventType;
  reason?: RouteSwitchReason;
  data: Record<string, string | number | boolean | null>;
};

export type RouteCandidateScore = {
  segment: TrackSegment;
  line: RailwayLine;
  distanceMeters: number;
  distanceScore: number;
  headingScore: number;
  continuityScore: number;
  historyScore: number;
  totalScore: number;
  projectedPoint: [number, number]; // [latitude, longitude]
  bearingDegrees: number;
  normalizedDistance?: number;
  continuityKind?: ContinuityKind;
  effectiveHeadingDegrees?: number | null;
  trackPositionMeters?: number;
};

export type RouteMatch = {
  selectedLine: RailwayLine;
  selectedSegment: TrackSegment;
  confidence: number; // 0.0 to 1.0
  candidates: RouteCandidateScore[];
  timestampMs: number;
  lockState?: RouteLockState;
  routeHealth?: RouteHealth | null;
  challenger?: RouteChallengerState | null;
  scoreMargin?: number;
  currentScore?: number | null;
  rescoredCurrentScore?: number | null;
  trajectoryHeadingDegrees?: number | null;
  switchReason?: RouteSwitchReason | null;
  manualLockAway?: boolean;
  showSelectedRoute?: boolean;
  windowScores?: WindowRouteScore[];
  lockEvents?: RouteLockEvent[];
};

export type JourneyState = {
  line: RailwayLine | null;
  direction: TravelDirection;
  directionName: string | null;
  previousStation: Station | null;
  nextStation: Station | null;
  distanceToNextStationMeters: number | null;
  progressRatio: number | null; // 0.0 to 1.0
  stationDataComplete: boolean; // false = station list completeness is not confirmed (e.g. sparse bundled fallback data, or remote data not yet available for this line); previous/nextStation should not be asserted
  confidence: number;
  status: 'INITIALIZING' | 'WAITING_FOR_GPS' | 'MATCHING_ROUTE' | 'TRACKING' | 'GPS_UNAVAILABLE' | 'ROUTE_UNCERTAIN' | 'GPS_LOW_ACCURACY';
  lockState?: RouteLockState;
  manualLockAway?: boolean;
};

export function isCommittedRouteLock(state: RouteLockState | undefined): boolean {
  return state === undefined || state === 'LOCKED' || state === 'SUSPICIOUS' || state === 'MANUAL_LOCK';
}

export function shouldDisplaySelectedRoute(match: RouteMatch | null | undefined): boolean {
  if (!match) return false;
  if (match.showSelectedRoute === false) return false;
  if (match.showSelectedRoute === true) return true;
  return isCommittedRouteLock(match.lockState);
}
