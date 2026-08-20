import type { EstimationLogEntry } from '../logging/logger';
import type { LocationSample } from '../../domain/models/location';
import type { RouteLockState, RouteSwitchReason } from '../../domain/models/railway';

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export type TelemetryEventBase = {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  eventId: string;
  sessionId: string;
  timestampMs: number;
  release: string;
  environment: string;
  datasetVersion: string | null;
  evenSdkVersion: string;
};

export type GpsTelemetryEvent = TelemetryEventBase & {
  type: 'gps-observation';
  location: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    speedMps: number | null;
    headingDegrees: number | null;
  };
  accepted: boolean;
  rejectionReason?: string;
};

export type EstimationTelemetryEvent = TelemetryEventBase & {
  type: 'estimation';
  speed: {
    osSpeedKmh: number | null;
    deltaSpeedKmh: number | null;
    trackSpeedKmh: number | null;
    deadReckoningSpeedKmh: number | null;
    selectedSpeedKmh: number | null;
    selectedSource: string;
    smoothedSpeedKmh: number | null;
  };
  navigation: {
    mode: string;
    confidence: number;
    gpsAgeMs: number | null;
    routePositionMeters: number | null;
  };
  match: {
    selectedLineId: string | null;
    selectedRouteId: string | null;
    selectedSegmentId: string | null;
    confidence: number;
    lockState?: RouteLockState | null;
    currentScore?: number | null;
    rescoredCurrentScore?: number | null;
    scoreMargin?: number | null;
    trajectoryHeadingDegrees?: number | null;
    routeHealthTotal?: number | null;
    challengerLineId?: string | null;
    challengerWins?: number | null;
    switchReason?: RouteSwitchReason | null;
    candidates: Array<{
      lineId: string;
      segmentId: string;
      distanceMeters: number;
      distanceScore: number;
      headingScore: number;
      continuityScore: number;
      historyScore?: number | null;
      totalScore: number;
    }>;
  };
  journey: {
    previousStationId: string | null;
    nextStationId: string | null;
    distanceToNextMeters: number | null;
    progressRatio: number | null;
  };
  bridge: {
    connected: boolean;
    lastImageResult: string;
    stalled?: boolean;
    currentOperation?: string | null;
    sessionEpoch?: number;
    recoveryCount?: number;
  };
};

export type BridgeOperationTelemetryEvent = TelemetryEventBase & {
  type: 'bridge-operation';
  operation: string;
  sequence: number;
  sessionEpoch: number;
  startedAtMs: number;
  completedAtMs?: number;
  elapsedMs?: number;
  result?: string;
  stalled?: boolean;
  slow?: boolean;
  error?: string;
};

export type StateTransitionTelemetryEvent = TelemetryEventBase & {
  type: 'state-transition';
  category: 'navigation' | 'route' | 'segment' | 'station' | 'bridge' | 'lifecycle';
  message: string;
  data: Record<string, string | number | boolean | null>;
};

export type TelemetryEvent =
  | GpsTelemetryEvent
  | EstimationTelemetryEvent
  | StateTransitionTelemetryEvent
  | BridgeOperationTelemetryEvent;

export type TelemetryIdentity = {
  sessionId: string;
  release: string;
  environment: string;
  datasetVersion?: string | null;
  evenSdkVersion?: string;
};

function eventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `event-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function base(identity: TelemetryIdentity, timestampMs: number): TelemetryEventBase {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: eventId(),
    sessionId: identity.sessionId,
    timestampMs,
    release: identity.release,
    environment: identity.environment,
    datasetVersion: identity.datasetVersion ?? null,
    evenSdkVersion: identity.evenSdkVersion ?? 'unknown',
  };
}

export function createGpsTelemetryEvent(
  identity: TelemetryIdentity,
  sample: LocationSample,
  accepted = true,
  rejectionReason?: string
): GpsTelemetryEvent {
  return {
    ...base(identity, sample.timestampMs),
    type: 'gps-observation',
    location: {
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracyMeters: sample.accuracyMeters,
      speedMps: sample.speedMps,
      headingDegrees: sample.headingDegrees,
    },
    accepted,
    ...(rejectionReason ? { rejectionReason } : {}),
  };
}

export function createEstimationTelemetryEvent(
  identity: TelemetryIdentity,
  entry: EstimationLogEntry
): EstimationTelemetryEvent {
  const { speedState, match, journey, rawLocation } = entry;
  const { candidates, selectedEstimate, navState } = speedState;
  const gpsAgeMs = navState.lastObservationTimestampMs === null
    ? null
    : Math.max(0, entry.timestampMs - navState.lastObservationTimestampMs);

  return {
    ...base(identity, entry.timestampMs),
    type: 'estimation',
    speed: {
      osSpeedKmh: candidates.osSpeed?.speedKmh ?? null,
      deltaSpeedKmh: candidates.positionDeltaSpeed?.speedKmh ?? null,
      trackSpeedKmh: candidates.trackDistanceSpeed?.speedKmh ?? null,
      deadReckoningSpeedKmh: candidates.deadReckoningSpeed?.speedKmh ?? null,
      selectedSpeedKmh: selectedEstimate.speedKmh,
      selectedSource: selectedEstimate.source,
      smoothedSpeedKmh: speedState.smoothedSpeedKmh,
    },
    navigation: {
      mode: navState.mode,
      confidence: navState.confidence,
      gpsAgeMs: rawLocation ? gpsAgeMs : null,
      routePositionMeters: navState.trackPositionMeters,
    },
    match: {
      selectedLineId: match?.selectedLine.id ?? null,
      selectedRouteId: match?.selectedSegment.routeId ?? navState.routeId,
      selectedSegmentId: match?.selectedSegment.id ?? navState.segmentId,
      confidence: match?.confidence ?? 0,
      lockState: match?.lockState ?? null,
      currentScore: match?.currentScore ?? null,
      rescoredCurrentScore: match?.rescoredCurrentScore ?? null,
      scoreMargin: match?.scoreMargin ?? null,
      trajectoryHeadingDegrees: match?.trajectoryHeadingDegrees ?? null,
      routeHealthTotal: match?.routeHealth?.total ?? null,
      challengerLineId: match?.challenger?.lineId ?? null,
      challengerWins: match?.challenger?.consecutiveWins ?? null,
      switchReason: match?.switchReason ?? null,
      candidates: (match?.candidates ?? []).map((candidate) => ({
        lineId: candidate.line.id,
        segmentId: candidate.segment.id,
        distanceMeters: candidate.distanceMeters,
        distanceScore: candidate.distanceScore,
        headingScore: candidate.headingScore,
        continuityScore: candidate.continuityScore,
        historyScore: candidate.historyScore,
        totalScore: candidate.totalScore,
      })),
    },
    journey: {
      previousStationId: journey.previousStation?.id ?? null,
      nextStationId: journey.nextStation?.id ?? null,
      distanceToNextMeters: journey.distanceToNextStationMeters,
      progressRatio: journey.progressRatio,
    },
    bridge: {
      connected: entry.bridgeConnected ?? false,
      lastImageResult: entry.lastImageResult ?? 'unknown',
      ...(entry.bridgeStalled !== undefined ? { stalled: entry.bridgeStalled } : {}),
      ...(entry.bridgeCurrentOperation !== undefined
        ? { currentOperation: entry.bridgeCurrentOperation }
        : {}),
      ...(entry.bridgeSessionEpoch !== undefined ? { sessionEpoch: entry.bridgeSessionEpoch } : {}),
      ...(entry.bridgeRecoveryCount !== undefined ? { recoveryCount: entry.bridgeRecoveryCount } : {}),
    },
  };
}

export type BridgeOperationTelemetryPayload = {
  operation: string;
  sequence: number;
  sessionEpoch: number;
  startedAtMs: number;
  completedAtMs?: number;
  elapsedMs?: number;
  result?: string;
  stalled?: boolean;
  slow?: boolean;
  error?: string;
};

export function createBridgeOperationTelemetryEvent(
  identity: TelemetryIdentity,
  timestampMs: number,
  payload: BridgeOperationTelemetryPayload
): BridgeOperationTelemetryEvent {
  return { ...base(identity, timestampMs), type: 'bridge-operation', ...payload };
}

export function createStateTransitionTelemetryEvent(
  identity: TelemetryIdentity,
  timestampMs: number,
  category: StateTransitionTelemetryEvent['category'],
  message: string,
  data: StateTransitionTelemetryEvent['data']
): StateTransitionTelemetryEvent {
  return { ...base(identity, timestampMs), type: 'state-transition', category, message, data };
}
