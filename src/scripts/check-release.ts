import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isReleaseAllowed, parseAllowedReleases } from '../infrastructure/telemetry/release-allowlist';

/**
 * Release consistency gate used by the version-bump workflow and CI.
 *
 * Checks that package.json and app.json carry the same version, that the
 * Worker allowlist in wrangler.toml accepts `railglance@<version>`, and that
 * .env.example points local development at the same release.
 */

export type ReleaseFiles = {
  packageJson: string;
  appJson: string;
  wranglerToml: string;
  envExample: string;
};

export type ReleaseCheckResult = { release: string; problems: string[] };

const RELEASE_PREFIX = 'railglance@';

function allowlistFromToml(toml: string): string[] | null {
  const match = /^\s*TELEMETRY_ALLOWED_RELEASES\s*=\s*"([^"]*)"/m.exec(toml);
  return match ? parseAllowedReleases(match[1]) : null;
}

function releaseFromEnvExample(env: string): string | null {
  const match = /^VITE_APP_RELEASE=(.*)$/m.exec(env);
  return match ? match[1].trim() : null;
}

export function checkRelease(files: ReleaseFiles): ReleaseCheckResult {
  const packageVersion = String(JSON.parse(files.packageJson).version);
  const appVersion = String(JSON.parse(files.appJson).version);
  const release = `${RELEASE_PREFIX}${packageVersion}`;
  const problems: string[] = [];

  if (appVersion !== packageVersion) {
    problems.push(`app.json version ${appVersion} must match package.json version ${packageVersion}`);
  }

  const allowlist = allowlistFromToml(files.wranglerToml);
  if (allowlist === null) {
    problems.push('wrangler.toml has no TELEMETRY_ALLOWED_RELEASES entry');
  } else if (!isReleaseAllowed(release, allowlist)) {
    const [major, minor] = packageVersion.split('.');
    problems.push(
      `TELEMETRY_ALLOWED_RELEASES does not cover ${release}; add ${RELEASE_PREFIX}${major}.${minor}.* and redeploy the Worker`
    );
  }

  const envRelease = releaseFromEnvExample(files.envExample);
  if (envRelease !== release) {
    problems.push(`.env.example VITE_APP_RELEASE should be ${release}`);
  }

  return { release, problems };
}

export function readReleaseFiles(root: string): ReleaseFiles {
  const read = (relative: string) => readFileSync(new URL(relative, root), 'utf8');
  return {
    packageJson: read('package.json'),
    appJson: read('app.json'),
    wranglerToml: read('infra/cloudflare/telemetry-worker/wrangler.toml'),
    envExample: read('.env.example'),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = new URL('../../', import.meta.url).href;
  const result = checkRelease(readReleaseFiles(root));
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  console.log(`✓ ${result.release} is consistent across package.json, app.json, wrangler.toml, and .env.example`);
}
