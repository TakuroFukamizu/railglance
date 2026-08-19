import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatBuildInfo, formatBuildTime, readBuildInfo } from '../../src/config/build-info';

describe('formatBuildTime', () => {
  it('renders the UTC build stamp in the requested timezone', () => {
    expect(formatBuildTime('2026-08-19T07:48:00.000Z', 'Asia/Tokyo')).toBe('2026/08/19 16:48');
  });

  it('renders midnight as 00 rather than 24', () => {
    expect(formatBuildTime('2026-08-19T15:00:00.000Z', 'Asia/Tokyo')).toBe('2026/08/20 00:00');
  });

  it('falls back when the stamp is missing or unparseable', () => {
    expect(formatBuildTime(null)).toBe('不明');
    expect(formatBuildTime('not-a-date')).toBe('不明');
  });
});

describe('formatBuildInfo', () => {
  it('shows the version and the build time together', () => {
    expect(
      formatBuildInfo({ version: '0.1.0', buildTimeIso: '2026-08-19T07:48:00.000Z' }, 'Asia/Tokyo')
    ).toBe('v0.1.0 · ビルド 2026/08/19 16:48');
  });
});

describe('readBuildInfo', () => {
  it('reads the constants Vite injects at build time', () => {
    const { version } = JSON.parse(readFileSync(new URL('../../app.json', import.meta.url), 'utf8'));
    const info = readBuildInfo();
    expect(info.version).toBe(version);
    expect(info.buildTimeIso).not.toBeNull();
    expect(Number.isNaN(new Date(info.buildTimeIso as string).getTime())).toBe(false);
  });
});
