export type BuildInfo = {
  version: string | null;
  buildTimeIso: string | null;
};

const UNKNOWN_LABEL = '不明';

/**
 * Reads the constants Vite injects at build time. The guards keep this usable from
 * plain `tsx` scripts and other non-bundled contexts where the constants are absent.
 * Missing values become null so that this module owns every user-facing fallback.
 */
export function readBuildInfo(): BuildInfo {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.trim() : '';
  const buildTimeIso = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__.trim() : '';
  return {
    version: version || null,
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
    // hourCycle rather than hour12: older WebViews resolve `hour12: false` to h24
    // for ja-JP, which renders midnight as 24:00. hour12 would override this.
    hourCycle: 'h23',
    timeZone,
  }).format(date);
}

export function formatBuildInfo(info: BuildInfo, timeZone?: string): string {
  const version = info.version ? `v${info.version}` : `バージョン${UNKNOWN_LABEL}`;
  return `${version} · ビルド ${formatBuildTime(info.buildTimeIso, timeZone)}`;
}
