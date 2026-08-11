export type TrackingConfig = {
  maxGpsAccuracyMeters: number;
  maxSpeedKmh: number;
  stopSpeedThresholdKmh: number;
  stopDurationSec: number;
  emaAlpha: number;
  hudRefreshMs: number;
  /**
   * GPS fix freshness limit. Once the newest fix is older than this, the last
   * GPS-derived speed is no longer reported as-is and dead-reckoning takes over.
   * This is NOT the "no GPS" threshold - see coastingMaxMs for that.
   */
  staleLocationMs: number;
  /**
   * Maximum dead-reckoning coasting budget measured from the last GPS fix.
   * Once exceeded (or once the navigation state is 'lost'), speed is reported
   * as unknown (HUD shows '--') instead of a coasted estimate.
   */
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
  staleLocationMs: 2000,  // A fix older than 2s is stale -> switch to dead-reckoning
  coastingMaxMs: 45000,   // Coast on dead-reckoning for up to 45s, then report unknown
  routeSearchRadiusMeters: 1000.0,
  routeSwitchConsecutiveCount: 3,
  routeSwitchMinimumMs: 5000,
  routeMatchLossGraceMs: 8000,
  confidenceHigh: 0.85,
  confidenceMedium: 0.6,
  confidenceLow: 0.4,
};
