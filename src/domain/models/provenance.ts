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

/**
 * Source id the MLIT adapter records in every provenance entry. Defined here, in a
 * dependency-free domain module, so the ETL, the deploy gate and the client-side
 * manifest parser all assert the same value and cannot drift apart.
 */
export const MLIT_SOURCE_ID = 'mlit-n02-23';
