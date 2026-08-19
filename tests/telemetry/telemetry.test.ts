import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { readTelemetryConfig } from '../../src/config/telemetry-config';
import { FullSpeedState } from '../../src/domain/models/location';
import { JourneyState } from '../../src/domain/models/railway';
import { EstimationLogEntry, EstimationLogger } from '../../src/infrastructure/logging/logger';
import { BufferedCloudTelemetrySink, PendingTelemetryStore, TelemetrySink } from '../../src/infrastructure/telemetry/sinks';
import { RuntimeTelemetryManager } from '../../src/infrastructure/telemetry/runtime-telemetry';
import type {
  CampaignQualificationStore,
  StoredCampaignQualification,
} from '../../src/infrastructure/telemetry/qualification-store';
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

class MemoryQualificationStore implements CampaignQualificationStore {
  public value: StoredCampaignQualification | null = null;
  public async get(): Promise<StoredCampaignQualification | null> { return this.value; }
  public async set(value: StoredCampaignQualification): Promise<void> { this.value = structuredClone(value); }
  public async clear(): Promise<void> { this.value = null; }
  public close(): void {}
}

function transitionEvent(eventId = 'event-1'): TelemetryEvent {
  return {
    schemaVersion: 1, type: 'state-transition', eventId, sessionId: 'session-1',
    timestampMs: Date.now(), release: 'test', environment: 'test', datasetVersion: null,
    evenSdkVersion: 'test', category: 'lifecycle', message: 'started', data: {},
  };
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
    stationDataComplete: true,
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
  it('has no build-time mode or bundled credential fields', () => {
    const config = readTelemetryConfig({ VITE_TELEMETRY_BATCH_SIZE: '999' });
    expect(config).not.toHaveProperty('mode');
    expect(config).not.toHaveProperty('uploadToken');
    expect(config.batchSize).toBe(200);
  });
});

describe('RuntimeTelemetryManager', () => {
  it('uses the campaign code once, persists qualification, and refreshes short upload tokens after restart', async () => {
    const sentrySink = new MemorySink();
    const qualificationStore = new MemoryQualificationStore();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const qualificationExpiresAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const uploadTokenExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/campaign/enroll')) return new Response(JSON.stringify({
        participantId: 'p_test', campaignId: 'campaign-test', campaignCredential: 'p_test.credential',
        qualificationExpiresAt, allowedReleases: ['test'], uploadToken: 'initial-token',
        uploadTokenExpiresAt,
      }), { status: 201 });
      if (url.endsWith('/session')) return new Response(JSON.stringify({
        token: 'refreshed-token', expiresAt: uploadTokenExpiresAt,
        qualificationExpiresAt, allowedReleases: ['test'],
      }), { status: 201 });
      return new Response('{}', { status: 202 });
    });
    const manager = new RuntimeTelemetryManager(
      sentrySink,
      readTelemetryConfig({ VITE_TELEMETRY_ENDPOINT: 'https://telemetry.example' }),
      { sessionId: 'session-1', release: 'test', environment: 'test' },
      fetchFn,
      qualificationStore
    );
    await manager.initialize();
    expect(manager.isDiagnosticEnabled()).toBe(false);

    await manager.startDiagnostic('tester-code');
    expect(manager.isDiagnosticEnabled()).toBe(true);
    const consentBody = JSON.parse(String(requests[0].init?.body));
    expect(consentBody).toMatchObject({ consent: true, accessCode: 'tester-code', sessionId: 'session-1' });
    expect(qualificationStore.value?.credential).toBe('p_test.credential');

    manager.write(transitionEvent());
    await manager.flush();
    expect(requests[1].init?.headers).toMatchObject({ authorization: 'Bearer initial-token' });
    expect(sentrySink.events).toHaveLength(1);

    await manager.shutdown();
    const restarted = new RuntimeTelemetryManager(
      new MemorySink(),
      readTelemetryConfig({ VITE_TELEMETRY_ENDPOINT: 'https://telemetry.example' }),
      { sessionId: 'session-2', release: 'test', environment: 'test' },
      fetchFn,
      qualificationStore
    );
    await restarted.initialize();
    expect(restarted.isDiagnosticEnabled()).toBe(true);
    const refreshRequest = requests.find((request) => request.url.endsWith('/session'));
    expect(JSON.parse(String(refreshRequest?.init?.body))).toMatchObject({
      campaignCredential: 'p_test.credential', release: 'test',
    });
    expect(JSON.stringify(refreshRequest?.init?.body)).not.toContain('tester-code');

    await restarted.stopDiagnostic();
    expect(restarted.isDiagnosticEnabled()).toBe(false);
    expect(qualificationStore.value).toMatchObject({ credential: 'p_test.credential', collectionEnabled: false });
    await restarted.resumeDiagnostic();
    expect(restarted.isDiagnosticEnabled()).toBe(true);
    await restarted.shutdown();
  });

  it('keeps unsent IndexedDB logs across forced-restart initialization and deletes them only on explicit request', async () => {
    const qualificationStore = new MemoryQualificationStore();
    qualificationStore.value = {
      key: 'active', schemaVersion: 1, participantId: 'p_test', campaignId: 'campaign-test',
      credential: 'p_test.credential', qualificationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      allowedReleases: ['test'], consentedAt: new Date().toISOString(), collectionEnabled: true,
      lastValidatedRelease: 'test',
    };
    const tokenResponse = {
      token: 'token', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      qualificationExpiresAt: qualificationStore.value.qualificationExpiresAt, allowedReleases: ['test'],
    };
    const failingFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).endsWith('/session')
      ? new Response(JSON.stringify(tokenResponse), { status: 201 })
      : new Response('{}', { status: 500 }));
    const first = new RuntimeTelemetryManager(
      new MemorySink(), readTelemetryConfig({ VITE_TELEMETRY_ENDPOINT: 'https://telemetry.example' }),
      { sessionId: 'session-1', release: 'test', environment: 'test' }, failingFetch, qualificationStore
    );
    await first.initialize();
    first.write(transitionEvent('pending-event'));
    await first.flush();
    await first.shutdown();

    const successfulFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).endsWith('/session')
      ? new Response(JSON.stringify(tokenResponse), { status: 201 })
      : new Response('{}', { status: 202 }));
    const restarted = new RuntimeTelemetryManager(
      new MemorySink(), readTelemetryConfig({ VITE_TELEMETRY_ENDPOINT: 'https://telemetry.example' }),
      { sessionId: 'session-2', release: 'test', environment: 'test' }, successfulFetch, qualificationStore
    );
    await restarted.initialize();
    await restarted.flush();
    expect(successfulFetch.mock.calls.some(([, init]) => String(init?.body).includes('pending-event'))).toBe(true);

    await restarted.deleteLocalData();
    await restarted.flush();
    const uploadsAfterDelete = successfulFetch.mock.calls.filter(([, init]) => String(init?.body).includes('pending-event'));
    expect(uploadsAfterDelete).toHaveLength(1);
    await restarted.shutdown();
  });

  it('stops collection immediately when a persisted qualification is revoked', async () => {
    const qualificationStore = new MemoryQualificationStore();
    qualificationStore.value = {
      key: 'active', schemaVersion: 1, participantId: 'p_revoked', campaignId: 'campaign-test',
      credential: 'p_revoked.credential', qualificationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      allowedReleases: ['test'], consentedAt: new Date().toISOString(), collectionEnabled: true,
      lastValidatedRelease: 'test',
    };
    const manager = new RuntimeTelemetryManager(
      new MemorySink(), readTelemetryConfig({ VITE_TELEMETRY_ENDPOINT: 'https://telemetry.example' }),
      { sessionId: 'session-1', release: 'test', environment: 'test' },
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 })),
      qualificationStore
    );

    await manager.initialize();
    expect(manager.getStatus().state).toBe('revoked');
    expect(manager.isDiagnosticEnabled()).toBe(false);
    expect(qualificationStore.value).toMatchObject({ collectionEnabled: false, credential: 'p_revoked.credential' });
    await manager.shutdown();
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
  await Dexie.delete('RailGlanceTelemetryControl');
});
