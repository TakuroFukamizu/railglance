export type BuildInfo = {
  version: string;
  buildTimeIso: string | null;
};

const UNKNOWN_LABEL = '不明';

/**
 * Reads the constants Vite injects at build time. The guards keep this usable from
 * plain `tsx` scripts and other non-bundled contexts where the constants are absent.
 */
export function readBuildInfo(): BuildInfo {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.trim() : '';
  const buildTimeIso = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__.trim() : '';
  return {
    version: version || UNKNOWN_LABEL,
    buildTimeIso: buildTimeIso || null,
  };
}

/** Formats the UTC build stamp in the viewer's own timezone, so testers read local time. */
export function formatBuildTime(buildTimeIso: string | null, timeZone?: string): string {
  if (!buildTimeIso) return UNKNOWN_LABEL;
  const date = new Date(buildTimeIso);
  if (Number.isNaN(date.getTime())) return UNKNOWN_LABEL;
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(date);
}

export function formatBuildInfo(info: BuildInfo, timeZone?: string): string {
  return `v${info.version} · ビルド ${formatBuildTime(info.buildTimeIso, timeZone)}`;
}
