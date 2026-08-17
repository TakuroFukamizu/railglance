import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../src/ui/html';

describe('escapeHtml', () => {
  it('escapes markup that would otherwise inject into innerHTML', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)"> JR&"中央"`)).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; JR&amp;&quot;中央&quot;'
    );
  });
});
