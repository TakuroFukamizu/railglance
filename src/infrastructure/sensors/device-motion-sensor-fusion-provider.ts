import { SensorFusionProvider } from '../../domain/interfaces/sensor-fusion';
import { SpeedEstimate } from '../../domain/models/location';

export class DeviceMotionSensorFusionProvider implements SensorFusionProvider {
  private isListening = false;
  private hasReceivedEvent = false;
  private lastAccelMagnitude = 0;
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
    const accel = event.acceleration || event.accelerationIncludingGravity;
    if (!accel || (accel.x === null && accel.y === null && accel.z === null)) return;

    this.hasReceivedEvent = true;
    if (this.permissionStatus !== 'granted') {
      this.permissionStatus = 'granted';
    }

    const x = accel.x ?? 0;
    const y = accel.y ?? 0;
    const z = accel.z ?? 0;

    const now = Date.now();
    const magnitude = Math.sqrt(x * x + y * y + z * z);

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
