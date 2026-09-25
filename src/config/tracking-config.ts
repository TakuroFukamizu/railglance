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
  /**
   * Extended coasting budget that applies while fresh accelerometer data
   * corroborates the dead-reckoning estimate (still vs moving). Falls back to
   * coastingMaxMs the moment motion data goes stale.
   */
  motionCoastingMaxMs: number;
  /**
   * How recent the last accelerometer observation must be to count as "fresh"
   * for the motion-assisted coasting extension.
   */
  motionFreshnessMs: number;
  routeSearchRadiusMeters: number;
  routeSwitchConsecutiveCount: number;
  routeSwitchMinimumMs: number;
  routeMatchLossGraceMs: number;
  confidenceHigh: number;
  confidenceMedium: number;
  confidenceLow: number;

  routeInitialLockMinScore: number;
  routeInitialLockMinMargin: number;
  routeInitialLockConsecutiveCount: number;
  routeInitialLockMinimumMs: number;

  routeSuspiciousHealthThreshold: number;
  routeSuspiciousMinimumMs: number;
  routeReacquireMinimumMs: number;

  routeChallengerMinMargin: number;
  routeChallengerConsecutiveCount: number;
  routeChallengerMinimumMs: number;

  routeTrajectoryWindowMs: number;
  routeTrajectoryMinDistanceMeters: number;

  routeManualLockMaxDistanceMeters: number;
  routeManualLockDurationMs: number;

  continuitySameSegment: number;
  continuityAdjacentSegment: number;
  continuityReachableSameRoute: number;
  continuitySameLineDisconnected: number;
  continuitySuspiciousScale: number;
  continuityReacquiringScale: number;

  routeWindowMs: number;
  routeWindowMinSamples: number;
  routeMinimumAccuracyMeters: number;
  routeConventionalMaxSpeedKmh: number;
  routeImpossibleSpeedPenalty: number;
  routeRelockConsecutiveCount: number;
  routeRelockMinimumMs: number;
  routeCandidateTieMargin: number;
  routeProgressJitterMeters: number;
  /**
   * Longest station hole bridged for the current (or an attached) segment: while the
   * sample is at most this far past the segment end, its distance is measured from the
   * extrapolated end tangent or a bridge to the aligned far-side segment end instead of
   * from the end vertex. MLIT segments end at junctions rather than at platforms.
   */
  routeSegmentEndOverrunMeters: number;
  /**
   * Straight-line bridges across a station hole: the far-side segment end must be at least
   * this far from the end vertex (closer ends are the same junction, not the far side of a
   * hole).
   */
  /**
   * How far past a segment's end the continuity bonus fades to zero while the station-hole
   * projection is carrying the candidate.
   */
  routeSegmentGapContinuityFadeMeters: number;
  /**
   * Consecutive fixes where another line's own geometry beats the projected distance by
   * more than the accuracy floor before the locked route is treated as suspicious.
   */
  routeSegmentGapContradictionCount: number;
  routeSegmentGapMinBridgeMeters: number;
  /** Maximum turn between a segment's end tangent, the bridge and the far-side segment. */
  routeSegmentGapMaxTurnDegrees: number;
  /**
   * A segment covers a sample past another segment's end (so there is no hole to bridge)
   * when it is within this many multiples of the sample's accuracy floor.
   */
  routeSegmentGapCoverAccuracyMultiple: number;
  /**
   * Another line's segment that carries the sample on its own geometry cancels a station-hole
   * projection when it is closer than the projection by more than this many accuracy floors
   * (a transfer at the station, or a biased trace defending a wrong lock).
   */
  routeSegmentGapOtherCoverMarginAccuracyMultiple: number;
  /**
   * Window distance falloff: the mean window distance at which the distance score halves,
   * in multiples of the fixes' accuracy floor. The score is never more lenient than the
   * linear falloff that reaches 0 at routeWindowLinearFalloffMeters.
   */
  routeWindowDistanceScalePerAccuracy: number;
  routeWindowLinearFalloffMeters: number;
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
  motionCoastingMaxMs: 180000, // With fresh accelerometer corroboration, coast up to 3min
  motionFreshnessMs: 2000,     // Motion observations older than this do not extend coasting
  routeSearchRadiusMeters: 1000.0,
  routeSwitchConsecutiveCount: 3,
  routeSwitchMinimumMs: 5000,
  routeMatchLossGraceMs: 8000,
  confidenceHigh: 0.85,
  confidenceMedium: 0.6,
  confidenceLow: 0.4,

  routeInitialLockMinScore: 55,
  routeInitialLockMinMargin: 12,
  routeInitialLockConsecutiveCount: 3,
  routeInitialLockMinimumMs: 3000,

  routeSuspiciousHealthThreshold: 0.45,
  routeSuspiciousMinimumMs: 4000,
  routeReacquireMinimumMs: 4000,

  routeChallengerMinMargin: 12,
  routeChallengerConsecutiveCount: 3,
  routeChallengerMinimumMs: 4000,

  routeTrajectoryWindowMs: 12000,
  routeTrajectoryMinDistanceMeters: 40,

  routeManualLockMaxDistanceMeters: 250,
  routeManualLockDurationMs: 30 * 60 * 1000,

  continuitySameSegment: 20,
  continuityAdjacentSegment: 15,
  continuityReachableSameRoute: 8,
  continuitySameLineDisconnected: 2,
  continuitySuspiciousScale: 0.4,
  continuityReacquiringScale: 0.05,

  routeWindowMs: 15000,
  routeWindowMinSamples: 4,
  routeMinimumAccuracyMeters: 15,
  routeConventionalMaxSpeedKmh: 160,
  routeImpossibleSpeedPenalty: 25,
  routeRelockConsecutiveCount: 3,
  routeRelockMinimumMs: 3000,
  routeCandidateTieMargin: 15,
  routeProgressJitterMeters: 15,
  routeSegmentEndOverrunMeters: 600,
  routeSegmentGapContinuityFadeMeters: 150,
  routeSegmentGapContradictionCount: 5,
  routeSegmentGapMinBridgeMeters: 30,
  routeSegmentGapMaxTurnDegrees: 45,
  routeSegmentGapCoverAccuracyMultiple: 2,
  routeSegmentGapOtherCoverMarginAccuracyMultiple: 1,
  routeWindowDistanceScalePerAccuracy: 2,
  routeWindowLinearFalloffMeters: 120,
};
