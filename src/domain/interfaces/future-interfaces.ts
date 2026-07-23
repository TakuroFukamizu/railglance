/**
 * Interface definitions reserved for Phase 2 & Phase 3 future enhancements.
 * Do not implement full functionality in Phase 1.
 */

export interface TimetableQuery {
  lineId: string;
  stationId: string;
  departureTimeMs: number;
}

export interface TrainTrip {
  tripId: string;
  trainNumber: string;
  trainType: string;
  destinationName: string;
  scheduledDepartureMs: number;
}

export interface TimetableRepository {
  findTrips(query: TimetableQuery): Promise<TrainTrip[]>;
}

export interface TrainObservation {
  lineId: string;
  currentStationId: string;
  nextStationId: string;
  timestampMs: number;
}

export interface TrainCandidateResult {
  trips: TrainTrip[];
  confidence: number;
}

export interface TrainCandidateEstimator {
  update(observation: TrainObservation): TrainCandidateResult;
}

export interface RealtimeTransitQuery {
  lineId: string;
}

export interface RealtimeTransitState {
  delayMinutes: number;
  isSuspended: boolean;
  activeTrains: Array<{
    trainNumber: string;
    currentLocation: string;
  }>;
}

export interface RealtimeTransitRepository {
  getRealtimeState(query: RealtimeTransitQuery): Promise<RealtimeTransitState>;
}
