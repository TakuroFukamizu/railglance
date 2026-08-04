export type TrackingConfig = {
  maxGpsAccuracyMeters: number;
  maxSpeedKmh: number;
  stopSpeedThresholdKmh: number;
  stopDurationSec: number;
  emaAlpha: number;
  hudRefreshMs: number;
  staleLocationMs: number;
  coastingMaxMs: number;
  routeSearchRadiusMeters: number;
  routeSwitchConsecutiveCount: number;
  routeSwitchMinimumMs: number;
  routeMatchLossGraceMs: number;
  confidenceHigh: number;
  confidenceMedium: number;
  confidenceLow: number;
};

export const DEFAULT_TRACKING_CONFIG: TrackingConfig = {
  maxGpsAccuracyMeters: 500.0,
  maxSpeedKmh: 400.0,
  stopSpeedThresholdKmh: 3.0,
  stopDurationSec: 5.0,
  emaAlpha: 0.3,
  hudRefreshMs: 1000,
  staleLocationMs: 45000, // 45 seconds tolerance before declaring NO_GPS
  coastingMaxMs: 45000,     // Allow dead-reckoning coasting in tunnels/shadows
  routeSearchRadiusMeters: 1000.0,
  routeSwitchConsecutiveCount: 3,
  routeSwitchMinimumMs: 5000,
  routeMatchLossGraceMs: 8000,
  confidenceHigh: 0.85,
  confidenceMedium: 0.6,
  confidenceLow: 0.4,
};
