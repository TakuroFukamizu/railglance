import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import worker, {
  type CampaignQualificationRecord,
  createUploadToken,
  parseTelemetryBatch,
  persistBatch,
  type TelemetryBatch,
  type WorkerEnvironment,
} from '../../infra/cloudflare/telemetry-worker/src/index';

const SIGNING_SECRET = 'signing-secret-at-least-for-tests';

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

type TestEnvironment = WorkerEnvironment & { records: Map<string, CampaignQualificationRecord> };

function environment(send = vi.fn().mockResolvedValue(undefined)): TestEnvironment {
  const records = new Map<string, CampaignQualificationRecord>();
  records.set('p_test', {
    version: 1,
    participantId: 'p_test',
    campaignId: 'campaign-test',
    credentialHash: 'not-used-for-upload',
    qualificationExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
    allowedReleases: ['railglance@test'],
    enrolledAt: Math.floor(Date.now() / 1000),
    revokedAt: null,
  });
  const env = {
    TELEMETRY_DIAGNOSTIC_ACCESS_CODE: 'tester-code',
    TELEMETRY_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
    TELEMETRY_ADMIN_TOKEN: 'admin-token',
    TELEMETRY_CAMPAIGN_ID: 'campaign-test',
    TELEMETRY_ALLOWED_RELEASES: 'railglance@test,railglance@next',
    TELEMETRY_QUALIFICATION_DAYS: '14',
    TELEMETRY_TOKEN_TTL_SECONDS: '900',
    TELEMETRY_ALLOWED_ORIGINS: 'https://app.example',
    TELEMETRY_ENROLL_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    TELEMETRY_PARTICIPANT_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    CAMPAIGN_QUALIFICATIONS: {
      idFromName: (name: string) => ({ name }),
      get: (id: object) => ({
        fetch: async (request: Request) => {
          const participantId = (id as { name: string }).name;
          if (request.method === 'GET') {
            const record = records.get(participantId);
            return record
              ? new Response(JSON.stringify(record), { headers: { 'content-type': 'application/json' } })
              : new Response('Not found', { status: 404 });
          }
          if (request.method === 'PUT') {
            records.set(participantId, await request.json() as CampaignQualificationRecord);
            return new Response(null, { status: 204 });
          }
          return new Response('Method not allowed', { status: 405 });
        },
      }),
    },
    TELEMETRY_QUEUE: { send },
    TELEMETRY_BUCKET: { put: vi.fn().mockResolvedValue(undefined) },
    records,
  };
  return env;
}

async function validToken(overrides: Partial<Parameters<typeof createUploadToken>[0]> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return createUploadToken({
    version: 1,
    participantId: 'p_test',
    campaignId: 'campaign-test',
    allowedReleases: ['railglance@test'],
    environment: 'prototype',
    issuedAt: now,
    expiresAt: now + 900,
    ...overrides,
  }, SIGNING_SECRET);
}

function uploadRequest(token: string, payload: unknown = batch(), origin?: string): Request {
  return new Request('https://worker.example/v1/telemetry', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(origin ? { origin } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

describe('Cloudflare telemetry Worker', () => {
  it('accepts an active campaign participant and strips unknown fields before enqueueing', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env = environment(send);
    const payload = batch();
    payload.events[0].unexpectedSecret = 'drop-me';
    const response = await worker.fetch(uploadRequest(await validToken(), payload, 'https://app.example'), env);

    expect(response.status).toBe(202);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].events[0]).not.toHaveProperty('unexpectedSecret');
  });

  it('enrolls once, persists a 7-30 day qualification, then refreshes without the campaign code', async () => {
    const env = environment();
    const enrollment = await worker.fetch(new Request('https://worker.example/v1/telemetry/campaign/enroll', {
      method: 'POST',
      headers: { origin: 'https://app.example', 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        sessionId: 'session-1',
        release: 'railglance@test',
        environment: 'prototype',
        consent: true,
        accessCode: 'tester-code',
      }),
    }), env);
    const enrolled = await enrollment.json() as {
      participantId: string;
      campaignCredential: string;
      qualificationExpiresAt: string;
      uploadTokenExpiresAt: string;
    };
    expect(enrollment.status).toBe(201);
    expect(Date.parse(enrolled.qualificationExpiresAt) - Date.now()).toBeGreaterThan(13 * 86_400_000);
    expect(Date.parse(enrolled.uploadTokenExpiresAt) - Date.now()).toBeLessThanOrEqual(901_000);

    const refresh = await worker.fetch(new Request('https://worker.example/v1/telemetry/session', {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 1,
        campaignCredential: enrolled.campaignCredential,
        release: 'railglance@test',
        environment: 'prototype',
      }),
    }), env);
    expect(refresh.status).toBe(201);
    expect(JSON.stringify(await refresh.json())).not.toContain('tester-code');
  });

  it('clamps campaign qualification lifetime to 7-30 days', async () => {
    const enroll = async (days: string) => {
      const env = environment();
      env.TELEMETRY_QUALIFICATION_DAYS = days;
      const response = await worker.fetch(new Request('https://worker.example/v1/telemetry/campaign/enroll', {
        method: 'POST',
        body: JSON.stringify({
          schemaVersion: 1, sessionId: 'session-1', release: 'railglance@test',
          environment: 'prototype', consent: true, accessCode: 'tester-code',
        }),
      }), env);
      return response.json() as Promise<{ qualificationExpiresAt: string }>;
    };
    const minimum = await enroll('1');
    const maximum = await enroll('90');
    expect(Date.parse(minimum.qualificationExpiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(Date.parse(maximum.qualificationExpiresAt) - Date.now()).toBeLessThanOrEqual(30 * 86_400_000 + 1_000);
  });

  it('supports immediate revocation and rejects an already-issued upload token', async () => {
    const env = environment();
    const token = await validToken();
    const revoke = await worker.fetch(new Request('https://worker.example/v1/telemetry/campaign/revoke', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token' },
      body: JSON.stringify({ participantId: 'p_test' }),
    }), env);
    expect(revoke.status).toBe(200);
    expect((await worker.fetch(uploadRequest(token), env)).status).toBe(401);
  });

  it('enforces release scope, expiration, origin, and request rate limits', async () => {
    const env = environment();
    expect((await worker.fetch(uploadRequest(await validToken(), batch(), 'https://evil.example'), env)).status).toBe(403);
    const now = Math.floor(Date.now() / 1000);
    expect((await worker.fetch(uploadRequest(await validToken({ issuedAt: now - 20, expiresAt: now - 10 })), env)).status).toBe(401);
    const wrongRelease = batch();
    wrongRelease.events[0].release = 'railglance@blocked';
    expect((await worker.fetch(uploadRequest(await validToken(), wrongRelease), env)).status).toBe(403);
    env.TELEMETRY_PARTICIPANT_RATE_LIMITER.limit = vi.fn().mockResolvedValue({ success: false });
    expect((await worker.fetch(uploadRequest(await validToken()), env)).status).toBe(429);
  });

  it('echoes an ephemeral-port loopback origin when the allowlist uses a port wildcard', async () => {
    const env = environment();
    env.TELEMETRY_ALLOWED_ORIGINS = 'http://localhost:5173,http://127.0.0.1:*';
    const token = await validToken();

    const ephemeral = await worker.fetch(uploadRequest(token, batch(), 'http://127.0.0.1:56984'), env);
    expect(ephemeral.status).toBe(202);
    expect(ephemeral.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:56984');

    const lowPort = await worker.fetch(uploadRequest(token, batch(), 'http://127.0.0.1:1'), env);
    expect(lowPort.status).toBe(202);
    expect(lowPort.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:1');

    const exactDev = await worker.fetch(uploadRequest(token, batch(), 'http://localhost:5173'), env);
    expect(exactDev.status).toBe(202);
    expect(exactDev.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('rejects scheme-mismatched and malformed suffixes against a port-wildcard allowlist', async () => {
    const env = environment();
    env.TELEMETRY_ALLOWED_ORIGINS = 'http://127.0.0.1:*';
    const token = await validToken();
    const reject = async (origin: string) => {
      const response = await worker.fetch(uploadRequest(token, batch(), origin), env);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      return response.status;
    };

    expect(await reject('https://127.0.0.1:56984')).toBe(403);
    expect(await reject('http://127.0.0.1:56984.evil.com')).toBe(403);
    expect(await reject('http://127.0.0.1:56984/path')).toBe(403);
    expect(await reject('http://127.0.0.1:56984@evil.com')).toBe(403);
  });

  it('fails closed on a bare wildcard origin entry instead of allowing every origin', async () => {
    const env = environment();
    env.TELEMETRY_ALLOWED_ORIGINS = '*';
    const response = await worker.fetch(uploadRequest(await validToken(), batch(), 'https://evil.example'), env);
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects invalid tokens, coordinate ranges, session consistency, and event count', async () => {
    const env = environment();
    expect((await worker.fetch(uploadRequest('wrong'), env)).status).toBe(401);
    const invalid = batch();
    invalid.events = [gpsEvent({ location: { latitude: 120, longitude: 139.7, accuracyMeters: 8, speedMps: 1, headingDegrees: 2 } })];
    expect((await worker.fetch(uploadRequest(await validToken(), invalid), env)).status).toBe(400);
    const mismatched = batch();
    mismatched.events[0].sessionId = 'another-session';
    expect(parseTelemetryBatch(mismatched)).toBeNull();
    expect(parseTelemetryBatch({ ...batch(), events: [] })).toBeNull();
    expect(parseTelemetryBatch({ ...batch(), events: Array.from({ length: 201 }, () => gpsEvent()) })).toBeNull();
  });

  it('rejects a declared body larger than the upload limit before parsing it', async () => {
    const response = await worker.fetch(new Request('https://worker.example/v1/telemetry', {
      method: 'POST',
      headers: { authorization: `Bearer ${await validToken()}`, 'content-length': '120001' },
      body: '{}',
    }), environment());
    expect(response.status).toBe(413);
  });

  it('falls back to direct R2 persistence when the Queue binding is not present', async () => {
    const env = environment();
    delete env.TELEMETRY_QUEUE;
    const response = await worker.fetch(uploadRequest(await validToken()), env);
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
