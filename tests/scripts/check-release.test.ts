import { describe, expect, it } from 'vitest';
import { checkRelease } from '../../src/scripts/check-release';

const files = (overrides: Partial<Record<'packageJson' | 'appJson' | 'wranglerToml' | 'envExample', string>> = {}) => ({
  packageJson: '{"name":"railglance","version":"0.1.4"}',
  appJson: '{"version":"0.1.4"}',
  wranglerToml: '[vars]\nTELEMETRY_ALLOWED_RELEASES = "railglance@0.1.3,railglance@0.1.*"\n',
  envExample: 'VITE_APP_RELEASE=railglance@0.1.4\n',
  ...overrides,
});

describe('checkRelease', () => {
  it('passes when versions agree and the allowlist covers the release', () => {
    expect(checkRelease(files())).toEqual({ release: 'railglance@0.1.4', problems: [] });
  });

  it('reports an app.json version that differs from package.json', () => {
    const result = checkRelease(files({ appJson: '{"version":"0.1.3"}' }));
    expect(result.problems).toEqual([expect.stringMatching(/app\.json.*0\.1\.3.*package\.json.*0\.1\.4/)]);
  });

  it('reports a release the Worker allowlist would reject', () => {
    const result = checkRelease(files({ packageJson: '{"version":"0.2.0"}', appJson: '{"version":"0.2.0"}', envExample: 'VITE_APP_RELEASE=railglance@0.2.0\n' }));
    expect(result.problems).toEqual([expect.stringMatching(/TELEMETRY_ALLOWED_RELEASES.*railglance@0\.2\.0.*railglance@0\.2\.\*/)]);
  });

  it('reports a stale VITE_APP_RELEASE in .env.example', () => {
    const result = checkRelease(files({ envExample: 'FOO=1\nVITE_APP_RELEASE=railglance@0.1.2\n' }));
    expect(result.problems).toEqual([expect.stringMatching(/\.env\.example.*railglance@0\.1\.4/)]);
  });

  it('reports a wrangler.toml without the allowlist variable', () => {
    const result = checkRelease(files({ wranglerToml: '[vars]\n' }));
    expect(result.problems).toEqual([expect.stringMatching(/TELEMETRY_ALLOWED_RELEASES/)]);
  });
});
