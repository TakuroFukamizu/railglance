export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeHtmlValue(value: string | number | null | undefined, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return escapeHtml(String(value));
}
