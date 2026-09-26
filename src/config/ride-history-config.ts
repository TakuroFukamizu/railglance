export type RideHistoryConfig = {
  /** Continuous committed lock duration required to confirm a ride, in milliseconds. */
  startConfirmMs: number;
  /** Duration without a committed lock before ending a ride, in milliseconds. */
  routeLostEndMs: number;
  /** Continuous stopped duration before ending a ride, in milliseconds. */
  stoppedEndMs: number;
  /** Minimum ride duration to retain, in milliseconds. */
  minRideDurationMs: number;
  /** Minimum ride distance to retain, in meters. */
  minRideDistanceMeters: number;
  /** Maximum GPS accuracy radius accepted for distance samples, in meters. */
  maxSampleAccuracyMeters: number;
  /** Maximum jump between consecutive samples added to distance, in meters. */
  maxSampleJumpMeters: number;
  /** Interval between periodic ride persistence updates, in milliseconds. */
  persistIntervalMs: number;
  /** Retention period for closed rides based on their start time, in milliseconds. */
  retentionMs: number;
  /** Maximum number of closed ride records to retain. */
  maxRecords: number;
  /** Number of recent rides displayed on the home card. */
  homeCardCount: number;
};

export const DEFAULT_RIDE_HISTORY_CONFIG: RideHistoryConfig = {
  startConfirmMs: 30_000,
  routeLostEndMs: 180_000,
  stoppedEndMs: 600_000,
  minRideDurationMs: 120_000,
  minRideDistanceMeters: 500,
  maxSampleAccuracyMeters: 100,
  maxSampleJumpMeters: 5_000,
  persistIntervalMs: 30_000,
  retentionMs: 90 * 24 * 60 * 60 * 1000,
  maxRecords: 500,
  homeCardCount: 3,
};
