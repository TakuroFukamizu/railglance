import { TrackingConfig } from '../../config/tracking-config';

export class SpeedFilter {
  private smoothedSpeedKmh: number | null = null;
  private stopStartTimeMs: number | null = null;
  private isStopped = false;

  constructor(private config: TrackingConfig) {}

  /**
   * Applies Exponential Moving Average (EMA) and outlier filtering to raw speed in km/h.
   */
  public filter(rawSpeedKmh: number, timestampMs: number): { smoothedKmh: number; isStopped: boolean } {
    // 1. Outlier filter
    if (rawSpeedKmh < 0 || rawSpeedKmh > this.config.maxSpeedKmh) {
      return {
        smoothedKmh: this.smoothedSpeedKmh ?? 0,
        isStopped: this.isStopped,
      };
    }

    // 2. EMA smoothing
    if (this.smoothedSpeedKmh === null) {
      this.smoothedSpeedKmh = rawSpeedKmh;
    } else {
      this.smoothedSpeedKmh =
        this.config.emaAlpha * rawSpeedKmh + (1 - this.config.emaAlpha) * this.smoothedSpeedKmh;
    }

    // 3. Stop detection logic
    if (this.smoothedSpeedKmh < this.config.stopThresholdKmh) {
      if (this.stopStartTimeMs === null) {
        this.stopStartTimeMs = timestampMs;
      } else if (timestampMs - this.stopStartTimeMs >= this.config.stopDurationMs) {
        this.isStopped = true;
        this.smoothedSpeedKmh = 0;
      }
    } else {
      this.stopStartTimeMs = null;
      this.isStopped = false;
    }

    return {
      smoothedKmh: Math.round(this.smoothedSpeedKmh * 10) / 10,
      isStopped: this.isStopped,
    };
  }

  public reset(): void {
    this.smoothedSpeedKmh = null;
    this.stopStartTimeMs = null;
    this.isStopped = false;
  }
}
