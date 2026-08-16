import { SensorFusionProvider } from '../../domain/interfaces/sensor-fusion';
import { MotionObservation } from '../../domain/speed/navigation-state-estimator';
import { SpeedEstimate } from '../../domain/models/location';

export class DeviceMotionSensorFusionProvider implements SensorFusionProvider {
  // Vibration energy below this reads as "no carriage vibration" (still).
  private static readonly STILL_VIBRATION_MPS2 = 0.05;
  // Sustained accel (EMA magnitude minus gravity) above this vetoes stillness.
  private static readonly STILL_NET_ACCEL_MPS2 = 0.5;
  // Quiet must persist this long before stillness is reported (guards against flapping).
  private static readonly STILL_SUSTAIN_MS = 3000;

  private isListening = false;
  private hasReceivedEvent = false;
  private lastAccelMagnitude = 0;
  private vibrationEnergyMps2 = 0;
  private stillCandidateSinceMs: number | null = null;
  private lastTimestampMs = 0;
  private currentEstimatedSpeedKmh: number | null = null;
  private isStoppedInferred = false;
  private permissionStatus: 'unknown' | 'granted' | 'denied' | 'unsupported' | 'insecure-context' = 'unknown';

  constructor() {
    this.startListening();
  }

  /**
   * Request DeviceMotion permission and ensure event listener is attached.
   */
  public async requestPermission(): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    // Attach listener immediately regardless of OS permission callback status
    this.startListening();

    if (!('DeviceMotionEvent' in window)) {
      this.permissionStatus = 'unsupported';
      return false;
    }

    try {
      const DeviceMotionEventAny = DeviceMotionEvent as any;
      if (typeof DeviceMotionEventAny.requestPermission === 'function') {
        const state = await DeviceMotionEventAny.requestPermission();
        console.log('[SensorFusion] DeviceMotionEvent.requestPermission returned:', state);

        if (state === 'granted') {
          this.permissionStatus = 'granted';
          return true;
        } else {
          // If iOS returns 'denied' or prompt already accepted in WebView, check if actual events arrive
          await new Promise((res) => setTimeout(res, 250));
          if (this.hasReceivedEvent) {
            console.log('[SensorFusion] Active devicemotion events received despite permission callback result!');
            this.permissionStatus = 'granted';
            return true;
          }
          this.permissionStatus = 'denied';
          return this.hasReceivedEvent;
        }
      } else {
        this.permissionStatus = 'granted';
        return true;
      }
    } catch (err) {
      console.warn('[SensorFusion] Exception during requestPermission:', err);
      // Fallback check if events arrive anyway
      await new Promise((res) => setTimeout(res, 200));
      if (this.hasReceivedEvent) {
        this.permissionStatus = 'granted';
        return true;
      }
      return false;
    }
  }

  private startListening(): void {
    if (this.isListening || typeof window === 'undefined') return;

    try {
      window.addEventListener('devicemotion', (event) => this.handleMotionEvent(event), true);
      this.isListening = true;
      console.log('[SensorFusion] DeviceMotion event listener attached.');
    } catch (err) {
      console.warn('[SensorFusion] Error attaching devicemotion listener:', err);
    }
  }

  private handleMotionEvent(event: DeviceMotionEvent): void {
    const gravityFree = event.acceleration;
    const hasGravityFree =
      gravityFree !== null &&
      (gravityFree.x !== null || gravityFree.y !== null || gravityFree.z !== null);
    const accel = hasGravityFree ? gravityFree : event.accelerationIncludingGravity;
    if (!accel || (accel.x === null && accel.y === null && accel.z === null)) return;

    // The gravity reference must match the array actually used: the old code
    // subtracted 9.8 whenever accelerationIncludingGravity merely existed, so a
    // resting device reading gravity-free ~0 was never classified as still.
    this.ingestAccelerationSample(
      accel.x ?? 0,
      accel.y ?? 0,
      accel.z ?? 0,
      !hasGravityFree,
      Date.now()
    );
  }

  /**
   * Feeds one accelerometer sample. Public so tests and native bridges can drive
   * the provider without synthesizing DeviceMotionEvent objects.
   */
  public ingestAccelerationSample(
    x: number,
    y: number,
    z: number,
    includesGravity: boolean,
    nowMs: number
  ): void {
    this.hasReceivedEvent = true;
    if (this.permissionStatus !== 'granted') {
      this.permissionStatus = 'granted';
    }

    const magnitude = Math.sqrt(x * x + y * y + z * z);

    // EMA of the magnitude tracks the quasi-static component (gravity + sustained accel).
    const alpha = 0.2;
    if (this.lastTimestampMs === 0) {
      this.lastAccelMagnitude = magnitude;
    } else {
      this.lastAccelMagnitude = alpha * magnitude + (1 - alpha) * this.lastAccelMagnitude;
    }

    // Vibration energy: how much the instantaneous magnitude deviates from its own EMA.
    // A cruising train averages ~9.8 like a resting one, but it vibrates; the average
    // alone cannot separate "stopped" from "constant speed".
    const deviation = Math.abs(magnitude - this.lastAccelMagnitude);
    this.vibrationEnergyMps2 = 0.1 * deviation + 0.9 * this.vibrationEnergyMps2;

    const netAccel = Math.abs(this.lastAccelMagnitude - (includesGravity ? 9.80665 : 0));

    if (this.lastTimestampMs > 0) {
      const dt = (nowMs - this.lastTimestampMs) / 1000;

      const isQuiet =
        this.vibrationEnergyMps2 < DeviceMotionSensorFusionProvider.STILL_VIBRATION_MPS2 &&
        netAccel < DeviceMotionSensorFusionProvider.STILL_NET_ACCEL_MPS2;
      if (isQuiet) {
        if (this.stillCandidateSinceMs === null) {
          this.stillCandidateSinceMs = nowMs;
        }
        this.isStoppedInferred =
          nowMs - this.stillCandidateSinceMs >= DeviceMotionSensorFusionProvider.STILL_SUSTAIN_MS;
      } else {
        this.stillCandidateSinceMs = null;
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

    this.lastTimestampMs = nowMs;
  }

  /**
   * Latest observation for NavigationStateEstimator. No orientation fusion is
   * available, so no signed longitudinal acceleration is ever claimed.
   */
  public getLatestObservation(): MotionObservation | null {
    if (!this.hasReceivedEvent || this.lastTimestampMs === 0) return null;
    return {
      trackAccelerationMps2: null,
      timestampMs: this.lastTimestampMs,
      isValid: true,
      isStillInferred: this.isStoppedInferred,
    };
  }

  public setLastKnownSpeed(speedKmh: number | null): void {
    if (speedKmh !== null && speedKmh >= 0) {
      this.currentEstimatedSpeedKmh = speedKmh;
    }
  }

  public getPermissionStatus(): string {
    return this.permissionStatus;
  }

  public async estimateSpeed(): Promise<SpeedEstimate> {
    const now = Date.now();

    if (!this.hasReceivedEvent || this.currentEstimatedSpeedKmh === null) {
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
