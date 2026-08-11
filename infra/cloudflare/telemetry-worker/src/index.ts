// Cloudflare Queues accepts at most 128 KB per message. Keep room for serialization metadata.
const MAX_BODY_BYTES = 120_000;
const MAX_EVENTS_PER_BATCH = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;

type JsonObject = Record<string, unknown>;

export type TelemetryBatch = {
  schemaVersion: 1;
  batchId: string;
  sessionId: string;
  sentAt: string;
  events: JsonObject[];
};

type QueueBinding = { send(message: TelemetryBatch): Promise<void> };
type R2Binding = {
  put(
    key: string,
    value: ArrayBuffer | ReadableStream,
    options?: { httpMetadata?: { contentType?: string; contentEncoding?: string }; customMetadata?: Record<string, string> }
  ): Promise<unknown>;
};

export type WorkerEnvironment = {
  TELEMETRY_BUCKET: R2Binding;
  TELEMETRY_QUEUE?: QueueBinding;
  TELEMETRY_UPLOAD_TOKEN: string;
  TELEMETRY_ALLOWED_ORIGINS?: string;
};

type QueueMessage = { body: TelemetryBatch };
type MessageBatch = { messages: QueueMessage[] };

function jsonResponse(status: number, body: JsonObject, origin: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function allowedOrigin(request: Request, env: WorkerEnvironment): string | null | false {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const allowed = (env.TELEMETRY_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : false;
}

function matchesToken(actual: string, expected: string): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : finiteNumber(value) ?? undefined;
}

function nullableString(value: unknown, maxLength = 200): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function sanitizeBase(value: JsonObject): JsonObject | null {
  const timestampMs = finiteNumber(value.timestampMs);
  const datasetVersion = value.datasetVersion === undefined ? null : nullableString(value.datasetVersion);
  if (
    value.schemaVersion !== 1 ||
    typeof value.eventId !== 'string' || !ID_PATTERN.test(value.eventId) ||
    typeof value.sessionId !== 'string' || !ID_PATTERN.test(value.sessionId) ||
    timestampMs === null || timestampMs < 0 || timestampMs > 8_640_000_000_000_000 ||
    typeof value.release !== 'string' || value.release.length === 0 || value.release.length > 200 ||
    typeof value.environment !== 'string' || value.environment.length === 0 || value.environment.length > 80 ||
    datasetVersion === undefined ||
    (value.evenSdkVersion !== undefined && (
      typeof value.evenSdkVersion !== 'string' || value.evenSdkVersion.length > 80
    ))
  ) return null;
  return {
    schemaVersion: 1,
    eventId: value.eventId,
    sessionId: value.sessionId,
    timestampMs,
    release: value.release,
    environment: value.environment,
    datasetVersion,
    evenSdkVersion: typeof value.evenSdkVersion === 'string' && value.evenSdkVersion.length <= 80
      ? value.evenSdkVersion
      : 'unknown',
  };
}

function sanitizeGps(value: JsonObject, base: JsonObject): JsonObject | null {
  const location = object(value.location);
  if (!location || typeof value.accepted !== 'boolean') return null;
  const latitude = finiteNumber(location.latitude);
  const longitude = finiteNumber(location.longitude);
  const accuracyMeters = finiteNumber(location.accuracyMeters);
  const speedMps = nullableNumber(location.speedMps);
  const headingDegrees = nullableNumber(location.headingDegrees);
  if (
    latitude === null || latitude < -90 || latitude > 90 ||
    longitude === null || longitude < -180 || longitude > 180 ||
    accuracyMeters === null || accuracyMeters < 0 ||
    speedMps === undefined || headingDegrees === undefined
  ) return null;
  const rejectionReason = value.rejectionReason === undefined
    ? undefined
    : nullableString(value.rejectionReason, 200);
  if (value.rejectionReason !== undefined && typeof rejectionReason !== 'string') return null;
  return {
    ...base,
    type: 'gps-observation',
    location: { latitude, longitude, accuracyMeters, speedMps, headingDegrees },
    accepted: value.accepted,
    ...(rejectionReason ? { rejectionReason } : {}),
  };
}

function sanitizeEstimation(value: JsonObject, base: JsonObject): JsonObject | null {
  const speed = object(value.speed);
  const navigation = object(value.navigation);
  const match = object(value.match);
  const journey = object(value.journey);
  const bridge = object(value.bridge);
  if (!speed || !navigation || !match || !journey || !bridge || !Array.isArray(match.candidates)) return null;

  const numericFields = (source: JsonObject, keys: string[]): JsonObject | null => {
    const result: JsonObject = {};
    for (const key of keys) {
      const field = nullableNumber(source[key]);
      if (field === undefined) return null;
      result[key] = field;
    }
    return result;
  };
  const speedNumbers = numericFields(speed, [
    'osSpeedKmh', 'deltaSpeedKmh', 'trackSpeedKmh', 'deadReckoningSpeedKmh',
    'selectedSpeedKmh', 'smoothedSpeedKmh',
  ]);
  const navigationNumbers = numericFields(navigation, ['confidence', 'gpsAgeMs', 'routePositionMeters']);
  if (!speedNumbers || !navigationNumbers || typeof speed.selectedSource !== 'string' || typeof navigation.mode !== 'string') return null;

  const selectedLineId = nullableString(match.selectedLineId);
  const selectedRouteId = nullableString(match.selectedRouteId);
  const selectedSegmentId = nullableString(match.selectedSegmentId);
  const matchConfidence = finiteNumber(match.confidence);
  if ([selectedLineId, selectedRouteId, selectedSegmentId].includes(undefined) || matchConfidence === null) return null;

  const candidates = match.candidates.slice(0, 20).map((candidate): JsonObject | null => {
    const candidateObject = object(candidate);
    if (!candidateObject || typeof candidateObject.lineId !== 'string' || typeof candidateObject.segmentId !== 'string') return null;
    const scores = numericFields(candidateObject, [
      'distanceMeters', 'distanceScore', 'headingScore', 'continuityScore', 'totalScore',
    ]);
    return scores ? { lineId: candidateObject.lineId, segmentId: candidateObject.segmentId, ...scores } : null;
  });
  if (candidates.some((candidate) => candidate === null)) return null;

  const previousStationId = nullableString(journey.previousStationId);
  const nextStationId = nullableString(journey.nextStationId);
  const journeyNumbers = numericFields(journey, ['distanceToNextMeters', 'progressRatio']);
  if (previousStationId === undefined || nextStationId === undefined || !journeyNumbers) return null;
  if (typeof bridge.connected !== 'boolean' || typeof bridge.lastImageResult !== 'string') return null;

  return {
    ...base,
    type: 'estimation',
    speed: { ...speedNumbers, selectedSource: speed.selectedSource },
    navigation: { ...navigationNumbers, mode: navigation.mode },
    match: {
      selectedLineId,
      selectedRouteId,
      selectedSegmentId,
      confidence: matchConfidence,
      candidates,
    },
    journey: { previousStationId, nextStationId, ...journeyNumbers },
    bridge: { connected: bridge.connected, lastImageResult: bridge.lastImageResult.slice(0, 500) },
  };
}

function sanitizeTransition(value: JsonObject, base: JsonObject): JsonObject | null {
  const allowedCategories = ['navigation', 'route', 'segment', 'station', 'bridge', 'lifecycle'];
  const data = object(value.data);
  if (
    typeof value.category !== 'string' || !allowedCategories.includes(value.category) ||
    typeof value.message !== 'string' || value.message.length > 200 || !data
  ) return null;
  const sanitizedData: JsonObject = {};
  for (const [key, field] of Object.entries(data).slice(0, 30)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) continue;
    if (field === null || typeof field === 'boolean' || (typeof field === 'string' && field.length <= 500)) {
      sanitizedData[key] = field;
    } else if (typeof field === 'number' && Number.isFinite(field)) {
      sanitizedData[key] = field;
    }
  }
  return { ...base, type: 'state-transition', category: value.category, message: value.message, data: sanitizedData };
}

export function sanitizeEvent(value: unknown): JsonObject | null {
  const source = object(value);
  if (!source) return null;
  const base = sanitizeBase(source);
  if (!base) return null;
  if (source.type === 'gps-observation') return sanitizeGps(source, base);
  if (source.type === 'estimation') return sanitizeEstimation(source, base);
  if (source.type === 'state-transition') return sanitizeTransition(source, base);
  return null;
}

export function parseTelemetryBatch(value: unknown): TelemetryBatch | null {
  const source = object(value);
  if (
    !source || source.schemaVersion !== 1 ||
    typeof source.batchId !== 'string' || !ID_PATTERN.test(source.batchId) ||
    typeof source.sessionId !== 'string' || !ID_PATTERN.test(source.sessionId) ||
    typeof source.sentAt !== 'string' || !Number.isFinite(Date.parse(source.sentAt)) ||
    !Array.isArray(source.events) || source.events.length === 0 || source.events.length > MAX_EVENTS_PER_BATCH
  ) return null;
  const events = source.events.map(sanitizeEvent);
  if (events.some((event) => event === null) || events.some((event) => event?.sessionId !== source.sessionId)) return null;
  return {
    schemaVersion: 1,
    batchId: source.batchId,
    sessionId: source.sessionId,
    sentAt: source.sentAt,
    events: events as JsonObject[],
  };
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export function r2Key(batch: TelemetryBatch): string {
  const timestamp = finiteNumber(batch.events[0]?.timestampMs) ?? Date.now();
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `telemetry/${year}/${month}/${day}/${batch.sessionId}/chunk-${batch.batchId}.ndjson.gz`;
}

export async function persistBatch(batch: TelemetryBatch, bucket: R2Binding): Promise<void> {
  const ndjson = `${batch.events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  await bucket.put(r2Key(batch), await gzip(ndjson), {
    httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
    customMetadata: {
      schemaVersion: String(batch.schemaVersion),
      sessionId: batch.sessionId,
      eventCount: String(batch.events.length),
      release: String(batch.events[0]?.release ?? 'unknown'),
      environment: String(batch.events[0]?.environment ?? 'unknown'),
      datasetVersion: String(batch.events[0]?.datasetVersion ?? 'unknown'),
      evenSdkVersion: String(batch.events[0]?.evenSdkVersion ?? 'unknown'),
    },
  });
}

async function handleFetch(request: Request, env: WorkerEnvironment): Promise<Response> {
  const origin = allowedOrigin(request, env);
  if (origin === false) return jsonResponse(403, { error: 'origin_not_allowed' }, null);

  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    if (url.pathname !== '/v1/telemetry') return jsonResponse(404, { error: 'not_found' }, origin);
    const headers = new Headers({
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
      'cache-control': 'no-store',
    });
    if (origin) {
      headers.set('access-control-allow-origin', origin);
      headers.set('vary', 'Origin');
    }
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST' || url.pathname !== '/v1/telemetry') {
    return jsonResponse(404, { error: 'not_found' }, origin);
  }
  if (!env.TELEMETRY_UPLOAD_TOKEN) return jsonResponse(503, { error: 'upload_not_configured' }, origin);
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ') || !matchesToken(authorization.slice(7), env.TELEMETRY_UPLOAD_TOKEN)) {
    return jsonResponse(401, { error: 'unauthorized' }, origin);
  }
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) return jsonResponse(413, { error: 'body_too_large' }, origin);

  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: 'body_too_large' }, origin);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonResponse(400, { error: 'invalid_json' }, origin);
  }
  const batch = parseTelemetryBatch(parsed);
  if (!batch) return jsonResponse(400, { error: 'invalid_batch' }, origin);

  if (env.TELEMETRY_QUEUE) await env.TELEMETRY_QUEUE.send(batch);
  else await persistBatch(batch, env.TELEMETRY_BUCKET);
  return jsonResponse(202, { accepted: true, batchId: batch.batchId }, origin);
}

async function handleQueue(batch: MessageBatch, env: WorkerEnvironment): Promise<void> {
  await Promise.all(batch.messages.map((message) => persistBatch(message.body, env.TELEMETRY_BUCKET)));
}

export default { fetch: handleFetch, queue: handleQueue };
