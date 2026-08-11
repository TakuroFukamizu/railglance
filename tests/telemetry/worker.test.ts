import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import worker, {
  parseTelemetryBatch,
  persistBatch,
  TelemetryBatch,
  WorkerEnvironment,
} from '../../infra/cloudflare/telemetry-worker/src/index';

function gpsEvent(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: 'gps-observation',
    eventId: 'event-1',
    sessionId: 'session-1',
    timestampMs: Date.UTC(2026, 7, 12),
    release: 'railglance@test',
    environment: 'prototype',
    location: { latitude: 35.6, longitude: 139.7, accuracyMeters: 8, speedMps: 10, headingDegrees: 20 },
    accepted: true,
    ...extra,
  };
}

function batch(): TelemetryBatch {
  return {
    schemaVersion: 1,
    batchId: 'batch-1',
    sessionId: 'session-1',
    sentAt: '2026-08-12T00:00:00.000Z',
    events: [gpsEvent()],
  };
}

function environment(send = vi.fn().mockResolvedValue(undefined)): WorkerEnvironment {
  return {
    TELEMETRY_UPLOAD_TOKEN: 'secret-token',
    TELEMETRY_ALLOWED_ORIGINS: 'https://app.example',
    TELEMETRY_QUEUE: { send },
    TELEMETRY_BUCKET: { put: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('Cloudflare telemetry Worker', () => {
  it('accepts an authenticated valid batch and strips unknown fields before enqueueing', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = environment(send);
    const payload = batch();
    payload.events[0].unexpectedSecret = 'drop-me';
    const response = await worker.fetch(new Request('https://worker.example/v1/telemetry', {
      method: 'POST',
      headers: {
        origin: 'https://app.example', authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    }), env);

    expect(response.status).toBe(202);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].events[0]).not.toHaveProperty('unexpectedSecret');
  });

  it('rejects disallowed origins, invalid tokens, and invalid coordinate ranges', async () => {
    const env = environment();
    const makeRequest = (origin: string, token: string, body: unknown) => new Request(
      'https://worker.example/v1/telemetry',
      { method: 'POST', headers: { origin, authorization: `Bearer ${token}` }, body: JSON.stringify(body) }
    );
    expect((await worker.fetch(makeRequest('https://evil.example', 'secret-token', batch()), env)).status).toBe(403);
    expect((await worker.fetch(makeRequest('https://app.example', 'wrong', batch()), env)).status).toBe(401);
    const invalid = batch();
    invalid.events = [gpsEvent({ location: { latitude: 120, longitude: 139.7, accuracyMeters: 8, speedMps: 1, headingDegrees: 2 } })];
    expect((await worker.fetch(makeRequest('https://app.example', 'secret-token', invalid), env)).status).toBe(400);
  });

  it('validates session consistency and event count', () => {
    const mismatched = batch();
    mismatched.events[0].sessionId = 'another-session';
    expect(parseTelemetryBatch(mismatched)).toBeNull();
    expect(parseTelemetryBatch({ ...batch(), events: [] })).toBeNull();
    expect(parseTelemetryBatch({ ...batch(), events: Array.from({ length: 201 }, () => gpsEvent()) })).toBeNull();
  });

  it('rejects a declared body larger than the upload limit before parsing it', async () => {
    const response = await worker.fetch(new Request('https://worker.example/v1/telemetry', {
      method: 'POST',
      headers: {
        origin: 'https://app.example', authorization: 'Bearer secret-token',
        'content-length': '120001',
      },
      body: '{}',
    }), environment());
    expect(response.status).toBe(413);
  });

  it('falls back to direct R2 persistence when the Queue binding is not present', async () => {
    const env = environment();
    delete env.TELEMETRY_QUEUE;
    const response = await worker.fetch(new Request('https://worker.example/v1/telemetry', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: JSON.stringify(batch()),
    }), env);
    expect(response.status).toBe(202);
    expect(env.TELEMETRY_BUCKET.put).toHaveBeenCalledOnce();
  });

  it('writes gzip NDJSON to the deterministic dated R2 key', async () => {
    let storedKey = '';
    let storedValue: ArrayBuffer | ReadableStream | null = null;
    const bucket = {
      put: vi.fn(async (key: string, value: ArrayBuffer | ReadableStream) => {
        storedKey = key;
        storedValue = value;
      }),
    };
    await persistBatch(batch(), bucket);

    expect(storedKey).toBe('telemetry/2026/08/12/session-1/chunk-batch-1.ndjson.gz');
    expect(storedValue).toBeInstanceOf(ArrayBuffer);
    const stored = storedValue as unknown;
    if (!(stored instanceof ArrayBuffer)) throw new Error('R2 value was not an ArrayBuffer');
    const decoded = gunzipSync(Buffer.from(stored)).toString('utf8');
    expect(decoded.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(decoded)).toMatchObject({ type: 'gps-observation', sessionId: 'session-1' });
  });
});
