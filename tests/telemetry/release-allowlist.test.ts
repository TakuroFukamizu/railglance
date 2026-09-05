import { describe, expect, it } from 'vitest';
import { isReleaseAllowed, parseAllowedReleases } from '../../src/infrastructure/telemetry/release-allowlist';

describe('isReleaseAllowed', () => {
  it('matches an exact entry', () => {
    expect(isReleaseAllowed('railglance@0.1.3', ['railglance@0.1.3'])).toBe(true);
    expect(isReleaseAllowed('railglance@0.1.4', ['railglance@0.1.3'])).toBe(false);
  });

  it('matches any numeric patch when the patch segment is a wildcard', () => {
    expect(isReleaseAllowed('railglance@0.1.0', ['railglance@0.1.*'])).toBe(true);
    expect(isReleaseAllowed('railglance@0.1.42', ['railglance@0.1.*'])).toBe(true);
  });

  it('does not let a patch wildcard cross minor, major, or prerelease boundaries', () => {
    expect(isReleaseAllowed('railglance@0.2.0', ['railglance@0.1.*'])).toBe(false);
    expect(isReleaseAllowed('railglance@0.10.0', ['railglance@0.1.*'])).toBe(false);
    expect(isReleaseAllowed('railglance@1.1.0', ['railglance@0.1.*'])).toBe(false);
    expect(isReleaseAllowed('railglance@0.1.4-beta', ['railglance@0.1.*'])).toBe(false);
    expect(isReleaseAllowed('railglance@0.1.', ['railglance@0.1.*'])).toBe(false);
    expect(isReleaseAllowed('railglance@0.1.4.1', ['railglance@0.1.*'])).toBe(false);
  });

  it('treats a wildcard anywhere but the whole patch segment as a literal', () => {
    expect(isReleaseAllowed('railglance@0.1.3', ['*'])).toBe(false);
    expect(isReleaseAllowed('railglance@0.1.3', ['railglance@*'])).toBe(false);
    expect(isReleaseAllowed('railglance@0.1.3', ['railglance@0.*.*'])).toBe(false);
    expect(isReleaseAllowed('railglance@0.1.3', ['railglance@0.1.3*'])).toBe(false);
    expect(isReleaseAllowed('railglance@0.1.3', ['railglance@0.1.*-beta'])).toBe(false);
    expect(isReleaseAllowed('*', ['*'])).toBe(true);
  });

  it('accepts a mixed list of exact and wildcard entries', () => {
    const entries = ['railglance@0.1.3', 'railglance@0.2.*'];
    expect(isReleaseAllowed('railglance@0.1.3', entries)).toBe(true);
    expect(isReleaseAllowed('railglance@0.2.7', entries)).toBe(true);
    expect(isReleaseAllowed('railglance@0.1.4', entries)).toBe(false);
  });

  it('never matches an empty release or an empty list', () => {
    expect(isReleaseAllowed('', ['railglance@0.1.*'])).toBe(false);
    expect(isReleaseAllowed('railglance@0.1.3', [])).toBe(false);
  });
});

describe('parseAllowedReleases', () => {
  it('splits, trims, and drops blank or oversized entries', () => {
    expect(parseAllowedReleases(' railglance@0.1.3 , railglance@0.1.*,, ')).toEqual([
      'railglance@0.1.3',
      'railglance@0.1.*',
    ]);
    expect(parseAllowedReleases(`a,${'x'.repeat(201)}`)).toEqual(['a']);
    expect(parseAllowedReleases(undefined)).toEqual([]);
  });
});
