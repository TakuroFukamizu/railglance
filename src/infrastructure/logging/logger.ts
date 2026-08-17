import { LocationSample, FullSpeedState } from '../../domain/models/location';
import { JourneyState, RouteLockEvent, RouteMatch } from '../../domain/models/railway';
import { HudViewModel } from '../../domain/models/hud';
import { TelemetrySink, NoopTelemetrySink } from '../telemetry/sinks';
import {
  createEstimationTelemetryEvent,
  createGpsTelemetryEvent,
  createStateTransitionTelemetryEvent,
  EstimationTelemetryEvent,
  TelemetryIdentity,
} from '../telemetry/types';

export type EstimationLogEntry = {
  timestampMs: number;
  rawLocation: LocationSample | null;
  speedState: FullSpeedState;
  match: RouteMatch | null;
  journey: JourneyState;
  hudViewModel: HudViewModel;
  bridgeConnected?: boolean;
  lastImageResult?: string;
};

export class EstimationLogger {
  private listeners: Array<(entry: EstimationLogEntry) => void> = [];
  private previousEstimation: EstimationTelemetryEvent | null = null;

  constructor(
    private readonly identity: TelemetryIdentity = {
      sessionId: 'local-session',
      release: 'railglance@development',
      environment: 'development',
      datasetVersion: null,
      evenSdkVersion: 'unknown',
    },
    private readonly sink: TelemetrySink = new NoopTelemetrySink(),
    private readonly diagnosticEnabled: boolean | (() => boolean) = false
  ) {}

  public subscribe(listener: (entry: EstimationLogEntry) => void): void {
    this.listeners.push(listener);
  }

  public log(entry: EstimationLogEntry): void {
    const { speedState, rawLocation } = entry;
    const { candidates, selectedEstimate, smoothedSpeedKmh } = speedState;

    console.log('[EstimationLog]', {
      time: new Date(entry.timestampMs).toISOString(),
      rawGpsSpeed: candidates.osSpeed?.speedKmh ?? null,
      deltaSpeed: candidates.positionDeltaSpeed?.speedKmh ?? null,
      trackSpeed: candidates.trackDistanceSpeed?.speedKmh ?? null,
      selectedSpeed: selectedEstimate.speedKmh,
      selectedSource: selectedEstimate.source,
      confidence: selectedEstimate.confidence,
      emaOutputSpeed: smoothedSpeedKmh,
      gpsAccuracyMeters: rawLocation?.accuracyMeters ?? null,
      selectedLine: entry.match?.selectedLine.name ?? 'None',
      lockState: entry.match?.lockState ?? entry.journey.lockState ?? null,
      scoreMargin: entry.match?.scoreMargin ?? null,
      routeHealth: entry.match?.routeHealth?.total ?? null,
    });

    for (const listener of this.listeners) {
      listener(entry);
    }

    const event = createEstimationTelemetryEvent(this.identity, entry);
    if (this.isDiagnosticEnabled()) this.sink.write(event);
    this.emitTransitions(event);
    this.previousEstimation = event;
  }

  public logGpsObservation(sample: LocationSample, accepted = true, rejectionReason?: string): void {
    if (!this.isDiagnosticEnabled()) return;
    this.sink.write(createGpsTelemetryEvent(this.identity, sample, accepted, rejectionReason));
  }

  public logRouteObservation(sample: LocationSample, match: RouteMatch | null): void {
    if (!match) return;
    this.writeRouteTransition(sample.timestampMs, 'route-observation', {
      lockState: match.lockState ?? null,
      currentLineId: match.selectedLine.id,
      currentSegmentId: match.selectedSegment.id,
      currentScore: match.currentScore ?? match.candidates[0]?.totalScore ?? null,
      rescoredScore: match.rescoredCurrentScore ?? null,
      topLineId: match.candidates[0]?.line.id ?? null,
      topScore: match.candidates[0]?.totalScore ?? null,
      secondScore: match.candidates[1]?.totalScore ?? null,
      scoreMargin: match.scoreMargin ?? null,
      healthTotal: match.routeHealth?.total ?? null,
      challengerLineId: match.challenger?.lineId ?? null,
      challengerWins: match.challenger?.consecutiveWins ?? null,
      trajectoryHeading: match.trajectoryHeadingDegrees ?? null,
      switchReason: match.switchReason ?? null,
    });
    this.logRouteEvents(match.lockEvents ?? [], sample.timestampMs);
  }

  public logRouteEvents(events: RouteLockEvent[], timestampMs: number): void {
    for (const event of events) {
      this.writeRouteTransition(timestampMs, event.type, {
        reason: event.reason ?? null,
        ...event.data,
      });
    }
  }

  private writeRouteTransition(
    timestampMs: number,
    message: string,
    data: Record<string, string | number | boolean | null>
  ): void {
    if (!this.isDiagnosticEnabled()) return;
    this.sink.write(createStateTransitionTelemetryEvent(this.identity, timestampMs, 'route', message, data));
  }

  public flush(): Promise<void> {
    return this.sink.flush();
  }

  public shutdown(): Promise<void> {
    return this.sink.shutdown();
  }

  private isDiagnosticEnabled(): boolean {
    return typeof this.diagnosticEnabled === 'function'
      ? this.diagnosticEnabled()
      : this.diagnosticEnabled;
  }

  private emitTransitions(current: EstimationTelemetryEvent): void {
    const previous = this.previousEstimation;
    if (!previous) {
      this.writeTransition(current, 'lifecycle', 'Telemetry session started', {
        navigationMode: current.navigation.mode,
        routeId: current.match.selectedRouteId,
        segmentId: current.match.selectedSegmentId,
      });
      if (current.match.selectedRouteId) {
        this.writeTransition(current, 'route', 'Route determined', {
          to: current.match.selectedRouteId,
          lineId: current.match.selectedLineId,
          confidence: current.match.confidence,
        });
      }
      if (current.match.selectedSegmentId) {
        this.writeTransition(current, 'segment', 'Segment determined', {
          to: current.match.selectedSegmentId,
          routeId: current.match.selectedRouteId,
        });
      }
      if (current.journey.nextStationId) {
        this.writeTransition(current, 'station', 'Next station determined', {
          to: current.journey.nextStationId,
          previousStationId: current.journey.previousStationId,
        });
      }
      return;
    }

    if (previous.navigation.mode !== current.navigation.mode) {
      this.writeTransition(current, 'navigation', 'Navigation mode changed', {
        from: previous.navigation.mode,
        to: current.navigation.mode,
        gpsAgeMs: current.navigation.gpsAgeMs,
        routeId: current.match.selectedRouteId,
        segmentId: current.match.selectedSegmentId,
      });
    }
    if (previous.match.selectedRouteId !== current.match.selectedRouteId) {
      this.writeTransition(current, 'route', 'Route changed', {
        from: previous.match.selectedRouteId,
        to: current.match.selectedRouteId,
        lineId: current.match.selectedLineId,
        confidence: current.match.confidence,
      });
    }
    if (previous.match.selectedSegmentId !== current.match.selectedSegmentId) {
      this.writeTransition(current, 'segment', 'Segment changed', {
        from: previous.match.selectedSegmentId,
        to: current.match.selectedSegmentId,
        routeId: current.match.selectedRouteId,
      });
    }
    if (previous.journey.nextStationId !== current.journey.nextStationId) {
      this.writeTransition(current, 'station', 'Next station changed', {
        from: previous.journey.nextStationId,
        to: current.journey.nextStationId,
        previousStationId: current.journey.previousStationId,
      });
    }
    if (
      previous.bridge.connected !== current.bridge.connected ||
      previous.bridge.lastImageResult !== current.bridge.lastImageResult
    ) {
      this.writeTransition(current, 'bridge', 'Even G2 bridge state changed', {
        connected: current.bridge.connected,
        lastImageResult: current.bridge.lastImageResult,
      });
    }
  }

  private writeTransition(
    current: EstimationTelemetryEvent,
    category: Parameters<typeof createStateTransitionTelemetryEvent>[2],
    message: string,
    data: Parameters<typeof createStateTransitionTelemetryEvent>[4]
  ): void {
    this.sink.write(
      createStateTransitionTelemetryEvent(this.identity, current.timestampMs, category, message, data)
    );
  }
}
