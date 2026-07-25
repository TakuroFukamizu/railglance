import { SensorFusionProvider } from '../../domain/interfaces/sensor-fusion';
import { SpeedEstimate } from '../../domain/models/location';

export class DeviceMotionSensorFusionProvider implements SensorFusionProvider {
  private isListening = false;
  private lastAccelMagnitude = 0;
  private lastTimestampMs = 0;
  private currentEstimatedSpeedKmh: number | null = null;
  private isStoppedInferred = false;

  constructor() {
    this.initSensor();
  }

  public static async requestMotionPermission(): Promise<boolean> {
    if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) {
      return false;
    }
    try {
      const DeviceMotionEventAny = DeviceMotionEvent as any;
      if (typeof DeviceMotionEventAny.requestPermission === 'function') {
        const permissionState = await DeviceMotionEventAny.requestPermission();
        return permissionState === 'granted';
      }
      return true;
    } catch (err) {
      console.warn('[SensorFusion] Error requesting permission:', err);
      return false;
    }
  }

  private async initSensor(): Promise<void> {
    if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) {
      console.log('[SensorFusion] DeviceMotionEvent is not supported on this device.');
      return;
    }

    try {
      window.addEventListener('devicemotion', (event) => this.handleMotionEvent(event), true);
      this.isListening = true;
      console.log('[SensorFusion] DeviceMotion listener activated successfully.');
    } catch (err) {
      console.warn('[SensorFusion] Error initializing DeviceMotion:', err);
    }
  }

  private handleMotionEvent(event: DeviceMotionEvent): void {
    const accel = event.acceleration || event.accelerationIncludingGravity;
    if (!accel || accel.x === null || accel.y === null || accel.z === null) return;

    const now = Date.now();
    const magnitude = Math.sqrt(accel.x * accel.x + accel.y * accel.y + accel.z * accel.z);

    const alpha = 0.2;
    this.lastAccelMagnitude = alpha * magnitude + (1 - alpha) * this.lastAccelMagnitude;

    const netAccel = Math.abs(this.lastAccelMagnitude - (event.accelerationIncludingGravity ? 9.80665 : 0));

    if (this.lastTimestampMs > 0) {
      const dt = (now - this.lastTimestampMs) / 1000;
      if (netAccel < 0.08) {
        this.isStoppedInferred = true;
      } else {
        this.isStoppedInferred = false;
      }

      if (this.currentEstimatedSpeedKmh !== null && dt > 0) {
        if (this.isStoppedInferred) {
          this.currentEstimatedSpeedKmh = Math.max(0, this.currentEstimatedSpeedKmh - 5.0 * dt);
        } else {
          this.currentEstimatedSpeedKmh = Math.max(0, this.currentEstimatedSpeedKmh - 0.2 * dt);
        }
      }
    }

    this.lastTimestampMs = now;
  }

  public setLastKnownSpeed(speedKmh: number | null): void {
    if (speedKmh !== null && speedKmh >= 0) {
      this.currentEstimatedSpeedKmh = speedKmh;
    }
  }

  public async estimateSpeed(): Promise<SpeedEstimate> {
    const now = Date.now();

    if (!this.isListening || this.currentEstimatedSpeedKmh === null) {
      return {
        speedKmh: null,
        confidence: 0.0,
        source: 'sensor-fusion',
        timestamp: now,
      };
    }

    const confidence = this.isStoppedInferred ? 0.6 : 0.75;
    return {
      speedKmh: Math.round(this.currentEstimatedSpeedKmh * 10) / 10,
      confidence,
      source: 'sensor-fusion',
      timestamp: now,
    };
  }
}
