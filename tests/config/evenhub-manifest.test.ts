import { describe, expect, it } from 'vitest';
import { createPackagedManifest } from '../../src/config/evenhub-manifest';

describe('Even Hub packaged manifest', () => {
  it('adds every configured outbound origin as an exact network permission entry', () => {
    const manifest = createPackagedManifest({
      package_id: 'com.example.app',
      permissions: [{ name: 'location', desc: 'location' }],
    }, {
      VITE_RAILWAY_DATA_BASE_URL: 'https://data.example/datasets',
      VITE_TELEMETRY_ENDPOINT: 'https://telemetry.example/',
      VITE_SENTRY_DSN: 'https://public@example.ingest.sentry.io/123',
      EVENHUB_NETWORK_ORIGINS: 'https://api.example/path,https://data.example',
    });

    expect(manifest.permissions).toContainEqual({
      name: 'network',
      desc: expect.any(String),
      whitelist: [
        'https://api.example',
        'https://data.example',
        'https://example.ingest.sentry.io',
        'https://telemetry.example',
      ],
    });
  });

  it('omits an unused network permission when the packaged app has no endpoints', () => {
    const manifest = createPackagedManifest({ permissions: [{ name: 'location', desc: 'location' }] }, {});
    expect(manifest.permissions).toEqual([{ name: 'location', desc: 'location' }]);
  });
});
