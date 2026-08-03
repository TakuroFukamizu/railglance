export type DataProvenance = {
  sourceId: string;
  sourceRecordId?: string;
  sourceVersion?: string;
  acquiredAt: string;
  licenseId: string;
  attributionText: string;
  manuallyCorrected: boolean;
};

export type SourceLicenseMetadata = {
  licenseId: string;
  name: string;
  url: string;
  attributionRequired: boolean;
  attributionText: string;
  redistributionAllowed: boolean;
};
