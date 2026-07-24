import { SpeedEstimate } from '../models/location';

/**
 * Reserved interface for Phase 2/3 sensor fusion (accelerometer, gyro, DeviceMotion, etc.)
 */
export interface SensorFusionProvider {
  estimateSpeed(): Promise<SpeedEstimate>;
}
