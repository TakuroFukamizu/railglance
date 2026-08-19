import { describe, expect, it } from 'vitest';
import { renderSyncBadge } from '../../src/ui/debug-panel';

describe('renderSyncBadge', () => {
  it('renders cloud as ready R2 H3 streaming', () => {
    const html = renderSyncBadge('cloud');
    expect(html).toContain('✓ Ready (R2 H3 Streaming)');
    expect(html).toContain('#00FF00');
  });

  it('renders cached as ready cached', () => {
    const html = renderSyncBadge('cached');
    expect(html).toContain('✓ Ready (Cached)');
  });

  it('renders downloading as connecting R2', () => {
    const html = renderSyncBadge('downloading');
    expect(html).toContain('⚡ Connecting R2...');
    expect(html).toContain('#FFFF00');
  });

  it('renders error as an error badge', () => {
    const html = renderSyncBadge('error');
    expect(html).toContain('✕ Error');
    expect(html).toContain('#FF6666');
  });

  it('renders unavailable as an unavailable badge', () => {
    const html = renderSyncBadge('unavailable');
    expect(html).toContain('✕ Unavailable');
    expect(html).toContain('#FF6666');
  });

  it('renders bundled as local sample', () => {
    const html = renderSyncBadge('bundled');
    expect(html).toContain('Local Sample');
    expect(html).toContain('#AAAAAA');
  });

  it('renders undefined as local sample', () => {
    const html = renderSyncBadge(undefined);
    expect(html).toContain('Local Sample');
    expect(html).toContain('#AAAAAA');
  });
});
