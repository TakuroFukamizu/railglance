export type EvenHubPermission = {
  name: string;
  desc: string;
  whitelist?: string[];
};

export type EvenHubManifest = Record<string, unknown> & {
  permissions?: EvenHubPermission[];
};

type BuildEnvironment = Record<string, string | undefined>;

const NETWORK_URL_KEYS = [
  'VITE_RAILWAY_DATA_BASE_URL',
  'VITE_TELEMETRY_ENDPOINT',
  'VITE_SENTRY_DSN',
] as const;

function origin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} must use http or https: ${value}`);
  }
  return url.origin;
}

export function networkOriginsFromEnvironment(env: BuildEnvironment): string[] {
  const candidates: Array<readonly [string, string]> = NETWORK_URL_KEYS.flatMap((key) => {
    const value = env[key]?.trim();
    return value ? [[key, value] as const] : [];
  });
  for (const value of (env.EVENHUB_NETWORK_ORIGINS ?? '').split(',')) {
    const trimmed = value.trim();
    if (trimmed) candidates.push(['EVENHUB_NETWORK_ORIGINS', trimmed]);
  }
  return [...new Set(candidates.map(([label, value]) => origin(value, label)))].sort();
}

export function createPackagedManifest(
  baseManifest: EvenHubManifest,
  env: BuildEnvironment
): EvenHubManifest {
  const origins = networkOriginsFromEnvironment(env);
  const permissions = (baseManifest.permissions ?? []).filter((permission) => permission.name !== 'network');
  if (origins.length > 0) {
    permissions.push({
      name: 'network',
      desc: '路線データ取得、障害通知、および同意したテスターの診断データ送信に利用します。',
      whitelist: origins,
    });
  }
  return { ...baseManifest, permissions };
}
