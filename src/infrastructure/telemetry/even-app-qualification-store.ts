import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { CampaignQualificationStore, StoredCampaignQualification } from './qualification-store';

export type EvenAppKeyValueStorage = Pick<EvenAppBridge, 'getLocalStorage' | 'setLocalStorage'>;

export const EVEN_APP_QUALIFICATION_KEY = 'railglance.telemetry.qualification';

const LOG_PREFIX = '[EvenAppCampaignQualificationStore]';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseQualification(raw: unknown): StoredCampaignQualification | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const stringFields = [
    'participantId', 'campaignId', 'credential', 'qualificationExpiresAt', 'consentedAt', 'lastValidatedRelease',
  ];
  if (
    record.key !== 'active' ||
    record.schemaVersion !== 1 ||
    !stringFields.every((field) => typeof record[field] === 'string') ||
    !isStringArray(record.allowedReleases) ||
    typeof record.collectionEnabled !== 'boolean'
  ) {
    return null;
  }
  return value as StoredCampaignQualification;
}

/**
 * Keeps the campaign qualification in the Even App's native key-value storage.
 *
 * The Even App WebView does not keep IndexedDB across app restarts, so a
 * qualification stored only there was lost on every relaunch and the tester
 * had to join again. The IndexedDB store stays as a mirror: it serves browsers
 * and the simulator when the bridge never shows up, and it carries a
 * qualification saved by an earlier build over to the bridge on first read.
 */
export class EvenAppCampaignQualificationStore implements CampaignQualificationStore {
  private storage: Promise<EvenAppKeyValueStorage> | null = null;

  constructor(
    private readonly connect: () => Promise<EvenAppKeyValueStorage>,
    private readonly fallback: CampaignQualificationStore,
    private readonly reportError: (error: unknown) => void = () => {}
  ) {}

  public async get(): Promise<StoredCampaignQualification | null> {
    const storage = await this.bridgeStorage();
    if (storage) {
      try {
        const stored = parseQualification(await storage.getLocalStorage(EVEN_APP_QUALIFICATION_KEY));
        if (stored) return stored;
      } catch (error) {
        console.warn(`${LOG_PREFIX} Reading the Even App storage failed; using IndexedDB.`, error);
      }
    }

    const legacy = await this.fallback.get();
    if (legacy && storage) await this.writeBridge(storage, JSON.stringify(legacy));
    return legacy;
  }

  public async set(value: StoredCampaignQualification): Promise<void> {
    await this.fallback.set(value);
    const storage = await this.bridgeStorage();
    if (storage) await this.writeBridge(storage, JSON.stringify(value));
  }

  public async clear(): Promise<void> {
    await this.fallback.clear();
    const storage = await this.bridgeStorage();
    // The bridge has no remove call; an empty value reads back as "nothing stored".
    // A failed clear must surface, or the qualification would come back on the next launch.
    if (storage && !await this.writeBridge(storage, '')) {
      throw new Error('Could not clear the qualification from the Even App storage.');
    }
  }

  public close(): void {
    this.fallback.close();
  }

  private async bridgeStorage(): Promise<EvenAppKeyValueStorage | null> {
    const pending = this.storage ??= this.connect();
    try {
      return await pending;
    } catch {
      // Retry on the next call: a bridge that shows up late must still receive the
      // tester's join, or the qualification would again live only in IndexedDB.
      if (this.storage === pending) this.storage = null;
      return null;
    }
  }

  private async writeBridge(storage: EvenAppKeyValueStorage, value: string): Promise<boolean> {
    try {
      if (await storage.setLocalStorage(EVEN_APP_QUALIFICATION_KEY, value) !== false) return true;
      this.reportBridgeWriteFailure(new Error('The Even App refused to save the qualification.'));
    } catch (error) {
      this.reportBridgeWriteFailure(error);
    }
    return false;
  }

  private reportBridgeWriteFailure(error: unknown): void {
    console.warn(`${LOG_PREFIX} Writing the Even App storage failed.`, error);
    this.reportError(error);
  }
}
