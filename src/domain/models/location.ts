export type LocationSample = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMps: number | null;
  headingDegrees: number | null;
  timestampMs: number;
};

export type SpeedEstimate = {
  speedMps: number | null;
  speedKmh: number | null;
  rawSpeedKmh: number | null;
  isStopped: boolean;
  isValid: boolean;
  timestampMs: number;
  source: 'gps' | 'calculated' | 'unknown';
};
