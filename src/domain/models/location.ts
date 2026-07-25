export type LocationSample = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMps: number | null;
  headingDegrees: number | null;
  timestampMs: number;
};

export type SpeedSource =
  | 'os-geolocation'
  | 'position-delta'
  | 'track-distance'
  | 'dead-reckoning'
  | 'motion-fusion'
  | 'sensor-fusion'
  | 'reacquired-gps'
  | 'unknown';

export type NavigationMode =
  | 'gps-locked'
  | 'gps-degraded'
  | 'dead-reckoning'
  | 'dead-reckoning-low-confidence'
  | 'reacquiring'
  | 'lost';

export type TrackNavigationState = {
  lineId: string | null;
  routeId: string | null;
  segmentId: string | null;
  direction: 'UP' | 'DOWN' | 'UNKNOWN';

  trackPositionMeters: number | null;
  velocityMps: number;
  accelerationMps2: number;

  accelerationBiasMps2: number;

  lastObservationTimestampMs: number | null;
  lastPredictionTimestampMs: number;

  mode: NavigationMode;
  confidence: number;
};

export type SpeedEstimate = {
  speedKmh: number | null;
  confidence: number;
  source: SpeedSource;
  timestamp: number;
  estimated?: boolean;
};

export type MultiSpeedCandidates = {
  osSpeed: SpeedEstimate | null;
  positionDeltaSpeed: SpeedEstimate | null;
  trackDistanceSpeed: SpeedEstimate | null;
  deadReckoningSpeed: SpeedEstimate | null;
  sensorFusionSpeed: SpeedEstimate | null;
};

export type FullSpeedState = {
  selectedEstimate: SpeedEstimate;
  smoothedSpeedKmh: number | null;
  isStopped: boolean;
  isValid: boolean;
  candidates: MultiSpeedCandidates;
  navState: TrackNavigationState;
};
