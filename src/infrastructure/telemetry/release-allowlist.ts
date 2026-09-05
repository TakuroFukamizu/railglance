/**
 * Release allowlist matching shared by the app and the telemetry Worker.
 *
 * An entry is either an exact release string (`railglance@0.1.3`) or a patch
 * wildcard (`railglance@0.1.*`) whose `*` stands for the whole patch segment
 * and matches only digits. A `*` anywhere else is a literal character, so a
 * bare `*` or `railglance@*` never matches a real release (fail closed).
 */

const MAX_ENTRY_LENGTH = 200;
const PATCH_WILDCARD_SUFFIX = '.*';

function matchesEntry(release: string, entry: string): boolean {
  if (release === entry) return true;
  if (!entry.endsWith(PATCH_WILDCARD_SUFFIX)) return false;
  const prefix = entry.slice(0, -PATCH_WILDCARD_SUFFIX.length);
  if (!/^[^*]+@\d+\.\d+$/.test(prefix)) return false;
  if (!release.startsWith(`${prefix}.`)) return false;
  return /^\d+$/.test(release.slice(prefix.length + 1));
}

export function isReleaseAllowed(release: string, entries: readonly string[]): boolean {
  if (release.length === 0) return false;
  return entries.some((entry) => matchesEntry(release, entry));
}

export function parseAllowedReleases(source: string | undefined): string[] {
  return (source ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= MAX_ENTRY_LENGTH);
}
