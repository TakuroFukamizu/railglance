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
  | 'sensor-fusion'
  | 'unknown';

export type SpeedEstimate = {
  speedKmh: number | null;
  confidence: number;
  source: SpeedSource;
  timestamp: number;
};

export type MultiSpeedCandidates = {
  osSpeed: SpeedEstimate | null;
  positionDeltaSpeed: SpeedEstimate | null;
  trackDistanceSpeed: SpeedEstimate | null;
  sensorFusionSpeed: SpeedEstimate | null;
};

export type FullSpeedState = {
  selectedEstimate: SpeedEstimate;
  smoothedSpeedKmh: number | null;
  isStopped: boolean;
  isValid: boolean;
  candidates: MultiSpeedCandidates;
};
