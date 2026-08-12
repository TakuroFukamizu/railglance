import Dexie, { Table } from 'dexie';
import { TelemetryEvent } from './types';

const MAX_UPLOAD_BODY_BYTES = 100_000;
const MAX_KEEPALIVE_BODY_BYTES = 60_000;

export class TelemetryHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Telemetry upload returned HTTP ${status}`);
  }
}

export interface TelemetrySink {
  write(event: TelemetryEvent): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export class CompositeTelemetrySink implements TelemetrySink {
  constructor(private readonly sinks: TelemetrySink[]) {}

  public write(event: TelemetryEvent): void {
    for (const sink of this.sinks) sink.write(event);
  }

  public async flush(): Promise<void> {
    await Promise.allSettled(this.sinks.map((sink) => sink.flush()));
  }

  public async shutdown(): Promise<void> {
    await Promise.allSettled(this.sinks.map((sink) => sink.shutdown()));
  }
}

export class NoopTelemetrySink implements TelemetrySink {
  public write(): void {}
  public async flush(): Promise<void> {}
  public async shutdown(): Promise<void> {}
}

export type PendingTelemetryStore = {
  append(event: TelemetryEvent): Promise<void>;
  list(limit: number): Promise<TelemetryEvent[]>;
  remove(eventIds: string[]): Promise<void>;
  prune(cutoffTimestampMs: number, maxEvents: number): Promise<void>;
  close(): void;
};

export class IndexedDbTelemetryStore extends Dexie implements PendingTelemetryStore {
  events!: Table<TelemetryEvent, string>;

  constructor(databaseName = 'RailGlanceTelemetry') {
    super(databaseName);
    this.version(1).stores({ events: 'eventId,timestampMs,sessionId' });
  }

  public async append(event: TelemetryEvent): Promise<void> {
    await this.events.put(event);
  }

  public async list(limit: number): Promise<TelemetryEvent[]> {
    return this.events.orderBy('timestampMs').limit(limit).toArray();
  }

  public async remove(eventIds: string[]): Promise<void> {
    await this.events.bulkDelete(eventIds);
  }

  public async prune(cutoffTimestampMs: number, maxEvents: number): Promise<void> {
    await this.events.where('timestampMs').below(cutoffTimestampMs).delete();
    const count = await this.events.count();
    if (count <= maxEvents) return;
    const overflow = await this.events.orderBy('timestampMs').limit(count - maxEvents).primaryKeys();
    await this.events.bulkDelete(overflow);
  }
}

export async function clearBufferedTelemetry(databaseName = 'RailGlanceTelemetry'): Promise<void> {
  await Dexie.delete(databaseName);
}

export type BufferedCloudTelemetrySinkOptions = {
  endpoint: string;
  uploadToken?: string;
  getUploadToken?: () => Promise<string>;
  batchSize: number;
  flushIntervalMs: number;
  maxStoredEvents: number;
  maxAgeMs: number;
  fetchFn?: typeof fetch;
  store?: PendingTelemetryStore;
  onError?: (error: unknown) => void;
};

export class BufferedCloudTelemetrySink implements TelemetrySink {
  private readonly store: PendingTelemetryStore;
  private readonly fetchFn: typeof fetch;
  private operation: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly options: BufferedCloudTelemetrySinkOptions) {
    this.store = options.store ?? new IndexedDbTelemetryStore();
    this.fetchFn = options.fetchFn ?? fetch;
    this.flushTimer = setInterval(() => void this.flush(), options.flushIntervalMs);
  }

  public write(event: TelemetryEvent): void {
    if (this.closed) return;
    this.queue(async () => {
      await this.store.append(event);
      await this.store.prune(Date.now() - this.options.maxAgeMs, this.options.maxStoredEvents);
      const pending = await this.store.list(this.options.batchSize);
      if (pending.length >= this.options.batchSize) {
        const sessionId = pending[0].sessionId;
        await this.send(pending.filter((item) => item.sessionId === sessionId));
      }
    });
  }

  public flush(): Promise<void> {
    if (this.closed) return this.operation;
    return this.queue(async () => {
      while (true) {
        const pending = await this.store.list(this.options.batchSize);
        if (pending.length === 0) break;
        const sessionId = pending[0].sessionId;
        const sessionBatch = pending.filter((event) => event.sessionId === sessionId);
        await this.send(sessionBatch);
      }
    });
  }

  public async shutdown(): Promise<void> {
    await this.close(true);
  }

  public async close(flush: boolean): Promise<void> {
    if (this.closed) return;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    try {
      if (flush) await this.flush();
      else await this.operation.catch(() => {});
    } finally {
      this.closed = true;
      this.store.close();
    }
  }

  private queue(task: () => Promise<void>): Promise<void> {
    const next = this.operation.catch(() => {}).then(task);
    this.operation = next.catch((error) => {
      console.warn('[Telemetry] Buffered operation failed; data will be retried:', error);
      this.options.onError?.(error);
    });
    return next;
  }

  private async send(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;
    const uploadEvents: TelemetryEvent[] = [];
    for (const event of events) {
      const candidate = [...uploadEvents, event];
      if (this.createPayload(candidate).byteLength > MAX_UPLOAD_BODY_BYTES) break;
      uploadEvents.push(event);
    }
    if (uploadEvents.length === 0) throw new Error('A single telemetry event exceeds the upload size limit');

    const { body } = this.createPayload(uploadEvents);
    const uploadToken = this.options.getUploadToken
      ? await this.options.getUploadToken()
      : this.options.uploadToken;
    if (!uploadToken) throw new Error('Telemetry upload token is unavailable');
    const response = await this.fetchFn(`${this.options.endpoint}/v1/telemetry`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${uploadToken}`,
        'content-type': 'application/json',
      },
      body,
      keepalive: new TextEncoder().encode(body).byteLength <= MAX_KEEPALIVE_BODY_BYTES,
    });
    if (!response.ok) throw new TelemetryHttpError(response.status);
    await this.store.remove(uploadEvents.map((event) => event.eventId));
  }

  private createPayload(events: TelemetryEvent[]): { body: string; byteLength: number } {
    const first = events[0];
    const last = events[events.length - 1];
    const batchId = `${first.eventId}_${last.eventId}_${events.length}`;
    const body = JSON.stringify({
      schemaVersion: 1,
      batchId,
      sessionId: first.sessionId,
      sentAt: new Date().toISOString(),
      events,
    });
    return { body, byteLength: new TextEncoder().encode(body).byteLength };
  }
}
