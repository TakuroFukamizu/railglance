import Dexie, { type Table } from 'dexie';

export type StoredCampaignQualification = {
  key: 'active';
  schemaVersion: 1;
  participantId: string;
  campaignId: string;
  credential: string;
  qualificationExpiresAt: string;
  allowedReleases: string[];
  consentedAt: string;
  collectionEnabled: boolean;
  lastValidatedRelease: string;
};

export interface CampaignQualificationStore {
  get(): Promise<StoredCampaignQualification | null>;
  set(value: StoredCampaignQualification): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export class IndexedDbCampaignQualificationStore extends Dexie implements CampaignQualificationStore {
  qualifications!: Table<StoredCampaignQualification, string>;

  constructor(databaseName = 'RailGlanceTelemetryControl') {
    super(databaseName);
    this.version(1).stores({ qualifications: 'key,participantId,campaignId' });
  }

  public async get(): Promise<StoredCampaignQualification | null> {
    return await this.qualifications.get('active') ?? null;
  }

  public async set(value: StoredCampaignQualification): Promise<void> {
    await this.qualifications.put(value);
  }

  public async clear(): Promise<void> {
    await this.qualifications.clear();
  }
}
