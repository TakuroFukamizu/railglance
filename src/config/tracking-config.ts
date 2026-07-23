export type TrackingConfig = {
  /** Maximum acceptable GPS accuracy in meters. Samples with accuracy > this will be discarded. */
  maxGpsAccuracyMeters: number;
  /** Radius in meters to search for track segment candidates around current location. */
  routeSearchRadiusMeters: number;
  /** Maximum physically reasonable speed in km/h (e.g. 400 km/h). */
  maxSpeedKmh: number;
  /** Speed threshold in km/h below which the train/device is considered stopped. */
  stopThresholdKmh: number;
  /** Duration in milliseconds of low speed needed to declare a complete stop. */
  stopDurationMs: number;
  /** Elapsed time in milliseconds after which a location sample is considered stale. */
  staleLocationMs: number;
  /** Interval in milliseconds for refreshing HUD display. */
  hudRefreshMs: number;
  /** Alpha parameter for Exponential Moving Average (EMA) smoothing for speed (0.0 < alpha <= 1.0). */
  emaAlpha: number;
  /** Number of consecutive matches required to switch active route. */
  routeSwitchConsecutiveCount: number;
  /** Minimum duration in milliseconds required to switch active route. */
  routeSwitchMinimumMs: number;
  /** High confidence threshold for definitive display (>= 0.80). */
  confidenceHigh: number;
  /** Medium confidence threshold for estimated display (>= 0.55). */
  confidenceMedium: number;
};

export const DEFAULT_TRACKING_CONFIG: TrackingConfig = {
  maxGpsAccuracyMeters: 500, // Relaxed from 50m to 500m for indoor/Wi-Fi positioning
  routeSearchRadiusMeters: 1000, // Expanded search radius to 1000m to accommodate low accuracy samples
  maxSpeedKmh: 400,
  stopThresholdKmh: 3,
  stopDurationMs: 5000,
  staleLocationMs: 30000, // Extended stale timeout to 30s for static browser positioning
  hudRefreshMs: 1000,
  emaAlpha: 0.3,
  routeSwitchConsecutiveCount: 3,
  routeSwitchMinimumMs: 5000,
  confidenceHigh: 0.80,
  confidenceMedium: 0.55,
};
