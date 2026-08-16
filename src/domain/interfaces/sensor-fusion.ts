import { SpeedEstimate } from '../models/location';
import { MotionObservation } from '../speed/navigation-state-estimator';

/**
 * Motion sensor source feeding dead reckoning (DeviceMotion today; gyro/orientation
 * fusion reserved for Phase 2/3). Optional input: everything must keep working when
 * no observation is ever produced (Requirements Sec 9).
 */
export interface SensorFusionProvider {
  estimateSpeed(): Promise<SpeedEstimate>;
  setLastKnownSpeed(speedKmh: number | null): void;
  /**
   * Latest accelerometer-derived observation, or null when no devicemotion event
   * has been received. The observation carries its own timestamp; freshness is
   * judged by the consumer (NavigationStateEstimator).
   */
  getLatestObservation(): MotionObservation | null;
}
