import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { readTelemetryConfig } from '../../src/config/telemetry-config';
import { FullSpeedState } from '../../src/domain/models/location';
import { JourneyState } from '../../src/domain/models/railway';
import { EstimationLogEntry, EstimationLogger } from '../../src/infrastructure/logging/logger';
import { BufferedCloudTelemetrySink, PendingTelemetryStore, TelemetrySink } from '../../src/infrastructure/telemetry/sinks';
import { TelemetryEvent } from '../../src/infrastructure/telemetry/types';
import { __testing as sentryTesting } from '../../src/infrastructure/observability/sentry';

class MemorySink implements TelemetrySink {
  public events: TelemetryEvent[] = [];
  public write(event: TelemetryEvent): void { this.events.push(event); }
  public async flush(): Promise<void> {}
  public async shutdown(): Promise<void> {}
}

class MemoryStore implements PendingTelemetryStore {
  public events: TelemetryEvent[] = [];
  public async append(event: TelemetryEvent): Promise<void> { this.events.push(event); }
  public async list(limit: number): Promise<TelemetryEvent[]> { return this.events.slice(0, limit); }
  public async remove(eventIds: string[]): Promise<void> {
    this.events = this.events.filter((event) => !eventIds.includes(event.eventId));
  }
  public async prune(cutoffTimestampMs: number, maxEvents: number): Promise<void> {
    this.events = this.events.filter((event) => event.timestampMs >= cutoffTimestampMs).slice(-maxEvents);
  }
  public close(): void {}
}

function entry(timestampMs: number, mode: FullSpeedState['navState']['mode'], routeId: string | null): EstimationLogEntry {
  const speedState: FullSpeedState = {
    selectedEstimate: { speedKmh: 42, confidence: 0.8, source: 'os-geolocation', timestamp: timestampMs },
    smoothedSpeedKmh: 40,
    isStopped: false,
    isValid: true,
    candidates: {
      osSpeed: { speedKmh: 42, confidence: 0.8, source: 'os-geolocation', timestamp: timestampMs },
      positionDeltaSpeed: null,
      trackDistanceSpeed: null,
      deadReckoningSpeed: null,
      sensorFusionSpeed: null,
    },
    navState: {
      lineId: routeId ? 'line-1' : null,
      routeId,
      segmentId: routeId ? 'segment-1' : null,
      direction: 'UP',
      trackPositionMeters: 120,
      velocityMps: 10,
      accelerationMps2: 0,
      accelerationBiasMps2: 0,
      lastObservationTimestampMs: timestampMs - 100,
      lastPredictionTimestampMs: timestampMs,
      mode,
      confidence: 0.8,
    },
  };
  const journey: JourneyState = {
    line: null,
    direction: 'UP',
    directionName: '上り',
    previousStation: null,
    nextStation: null,
    distanceToNextStationMeters: 1000,
    progressRatio: 0.5,
    confidence: 0.8,
    status: 'TRACKING',
  };
  return {
    timestampMs,
    rawLocation: {
      latitude: 35.6,
      longitude: 139.7,
      accuracyMeters: 8,
      speedMps: 10,
      headingDegrees: 20,
      timestampMs,
    },
    speedState,
    match: null,
    journey,
    hudViewModel: {
      header: { lineName: 'Test', serviceOrDirection: '上り' },
      speed: { displaySpeedKmhText: '40', unitText: 'km/h', isEstimated: false },
      segment: {
        previousStationName: 'A', nextStationName: 'B', progressRatio: 0.5,
        segmentMaxSpeedText: '', distanceToNextText: '1km',
      },
      footer: { leftInfo: '', statusRight: 'GPS' },
      statusMode: 'GPS',
      rawFormattedText: '',
      timestampMs,
    },
    bridgeConnected: true,
    lastImageResult: 'success',
  };
}

describe('telemetry configuration', () => {
  it('defaults to privacy-preserving errors-only mode and caps trace-independent batch settings', () => {
    const config = readTelemetryConfig({ VITE_TELEMETRY_BATCH_SIZE: '999' });
    expect(config.mode).toBe('errors-only');
    expect(config.batchSize).toBe(200);
  });
});

describe('EstimationLogger telemetry', () => {
  it('records diagnostic estimates and emits transition events without GPS coordinates', () => {
    const sink = new MemorySink();
    const logger = new EstimationLogger(
      { sessionId: 'session-1', release: 'test', environment: 'test' }, sink, true
    );
    logger.log(entry(1_000, 'gps-locked', 'route-1'));
    logger.log(entry(2_000, 'dead-reckoning', 'route-1'));

    expect(sink.events.filter((event) => event.type === 'estimation')).toHaveLength(2);
    const transition = sink.events.find(
      (event) => event.type === 'state-transition' && event.category === 'navigation'
    );
    expect(transition).toMatchObject({ data: { from: 'gps-locked', to: 'dead-reckoning' } });
    expect(JSON.stringify(transition)).not.toContain('35.6');
    expect(JSON.stringify(transition)).not.toContain('139.7');
  });

  it('does not persist GPS or estimation events outside diagnostic mode', () => {
    const sink = new MemorySink();
    const logger = new EstimationLogger(
      { sessionId: 'session-1', release: 'test', environment: 'test' }, sink, false
    );
    const sample = entry(1_000, 'gps-locked', 'route-1').rawLocation!;
    logger.logGpsObservation(sample);
    logger.log(entry(1_000, 'gps-locked', 'route-1'));
    expect(sink.events.every((event) => event.type === 'state-transition')).toBe(true);
  });
});

describe('BufferedCloudTelemetrySink', () => {
  afterEach(() => vi.restoreAllMocks());

  it('removes buffered events only after a successful upload', async () => {
    const store = new MemoryStore();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 202 }));
    const sink = new BufferedCloudTelemetrySink({
      endpoint: 'https://telemetry.example', uploadToken: 'token', batchSize: 100,
      flushIntervalMs: 60_000, maxStoredEvents: 200, maxAgeMs: 60_000, store, fetchFn,
    });
    const event = {
      schemaVersion: 1, type: 'state-transition', eventId: 'event-1', sessionId: 'session-1',
      timestampMs: Date.now(), release: 'test', environment: 'test', datasetVersion: null,
      evenSdkVersion: 'test', category: 'lifecycle',
      message: 'started', data: {},
    } satisfies TelemetryEvent;
    sink.write(event);
    await sink.flush();

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(store.events).toHaveLength(0);
    await sink.shutdown();
  });

  it('retains buffered events when upload fails', async () => {
    const store = new MemoryStore();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 500 }));
    const sink = new BufferedCloudTelemetrySink({
      endpoint: 'https://telemetry.example', uploadToken: 'token', batchSize: 100,
      flushIntervalMs: 60_000, maxStoredEvents: 200, maxAgeMs: 60_000, store, fetchFn,
    });
    sink.write({
      schemaVersion: 1, type: 'state-transition', eventId: 'event-1', sessionId: 'session-1',
      timestampMs: Date.now(), release: 'test', environment: 'test', datasetVersion: null,
      evenSdkVersion: 'test', category: 'lifecycle',
      message: 'started', data: {},
    });
    await expect(sink.flush()).rejects.toThrow('HTTP 500');
    expect(store.events).toHaveLength(1);
  });

  it('splits a logical batch so every Queue message stays below the upload limit', async () => {
    const store = new MemoryStore();
    const bodies: string[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response('{}', { status: 202 });
    });
    const sink = new BufferedCloudTelemetrySink({
      endpoint: 'https://telemetry.example', uploadToken: 'token', batchSize: 100,
      flushIntervalMs: 60_000, maxStoredEvents: 200, maxAgeMs: 60_000, store, fetchFn,
    });
    for (const eventId of ['event-1', 'event-2']) {
      sink.write({
        schemaVersion: 1, type: 'state-transition', eventId, sessionId: 'session-1',
        timestampMs: Date.now(), release: 'test', environment: 'test', datasetVersion: null,
        evenSdkVersion: 'test', category: 'lifecycle', message: 'started', data: { detail: 'x'.repeat(60_000) },
      });
    }
    await sink.flush();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(bodies.every((body) => new TextEncoder().encode(body).byteLength <= 100_000)).toBe(true);
    expect(store.events).toHaveLength(0);
    await sink.shutdown();
  });
});

describe('Sentry privacy scrubber', () => {
  it('recursively removes precise location fields', () => {
    expect(sentryTesting.scrubLocation({
      context: { latitude: 35.6, longitude: 139.7, routeId: 'route-1' },
      extra: { rawLocation: { lat: 1, lon: 2 }, safe: true },
    })).toEqual({ context: { routeId: 'route-1' }, extra: { safe: true } });
  });
});

afterEach(async () => {
  await Dexie.delete('RailGlanceTelemetry');
});
