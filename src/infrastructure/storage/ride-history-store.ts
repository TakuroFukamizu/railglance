import Dexie, { type Table } from 'dexie';
import type { RideRecord } from '../../domain/history/ride-record';

export type RideHistoryStore = {
  put(record: RideRecord): Promise<void>;
  get(id: string): Promise<RideRecord | undefined>;
  findOpen(): Promise<RideRecord[]>;
  listRecent(limit: number): Promise<RideRecord[]>;
  listAll(): Promise<RideRecord[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  prune(cutoffStartedAtMs: number, maxRecords: number): Promise<void>;
  close(): void;
};

export class IndexedDbRideHistoryStore extends Dexie implements RideHistoryStore {
  rides!: Table<RideRecord, string>;

  constructor(databaseName = 'RailGlanceRideHistory') {
    super(databaseName);
    this.version(1).stores({ rides: 'id,startedAtMs,status' });
  }

  public async put(record: RideRecord): Promise<void> {
    await this.rides.put(record);
  }

  public async get(id: string): Promise<RideRecord | undefined> {
    return this.rides.get(id);
  }

  public async findOpen(): Promise<RideRecord[]> {
    return this.rides.where('status').equals('open').toArray();
  }

  public async listRecent(limit: number): Promise<RideRecord[]> {
    return this.rides
      .orderBy('startedAtMs')
      .reverse()
      .filter((record) => record.status === 'closed')
      .limit(limit)
      .toArray();
  }

  public async listAll(): Promise<RideRecord[]> {
    return this.rides
      .orderBy('startedAtMs')
      .reverse()
      .filter((record) => record.status === 'closed')
      .toArray();
  }

  public async remove(id: string): Promise<void> {
    await this.rides.delete(id);
  }

  public async clear(): Promise<void> {
    await this.rides.clear();
  }

  public async prune(cutoffStartedAtMs: number, maxRecords: number): Promise<void> {
    const expired = await this.rides
      .where('startedAtMs')
      .below(cutoffStartedAtMs)
      .filter((record) => record.status === 'closed')
      .primaryKeys();
    await this.rides.bulkDelete(expired);

    const closedCount = await this.rides.where('status').equals('closed').count();
    if (closedCount <= maxRecords) return;

    const overflow = await this.rides
      .orderBy('startedAtMs')
      .filter((record) => record.status === 'closed')
      .limit(closedCount - maxRecords)
      .primaryKeys();
    await this.rides.bulkDelete(overflow);
  }
}

function copyRideRecord(record: RideRecord): RideRecord {
  return { ...record, passedStations: [...record.passedStations] };
}

export class InMemoryRideHistoryStore implements RideHistoryStore {
  private readonly records = new Map<string, RideRecord>();

  public async put(record: RideRecord): Promise<void> {
    this.records.set(record.id, copyRideRecord(record));
  }

  public async get(id: string): Promise<RideRecord | undefined> {
    const record = this.records.get(id);
    return record === undefined ? undefined : copyRideRecord(record);
  }

  public async findOpen(): Promise<RideRecord[]> {
    return [...this.records.values()].filter((record) => record.status === 'open').map(copyRideRecord);
  }

  public async listRecent(limit: number): Promise<RideRecord[]> {
    return this.closedDescending().slice(0, limit);
  }

  public async listAll(): Promise<RideRecord[]> {
    return this.closedDescending();
  }

  public async remove(id: string): Promise<void> {
    this.records.delete(id);
  }

  public async clear(): Promise<void> {
    this.records.clear();
  }

  public async prune(cutoffStartedAtMs: number, maxRecords: number): Promise<void> {
    for (const [id, record] of this.records) {
      if (record.status === 'closed' && record.startedAtMs < cutoffStartedAtMs) {
        this.records.delete(id);
      }
    }
    const closed = [...this.records.values()]
      .filter((record) => record.status === 'closed')
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
    if (closed.length <= maxRecords) return;
    for (const record of closed.slice(0, closed.length - maxRecords)) {
      this.records.delete(record.id);
    }
  }

  public close(): void {}

  private closedDescending(): RideRecord[] {
    return [...this.records.values()]
      .filter((record) => record.status === 'closed')
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .map(copyRideRecord);
  }
}
