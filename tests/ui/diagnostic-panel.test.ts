import { describe, expect, it } from 'vitest';
import { buildDiagnosticPanelView, formatLocalDateTime } from '../../src/ui/diagnostic-panel';
import type { DiagnosticStatus } from '../../src/infrastructure/telemetry/runtime-telemetry';

const formatDateTime = (iso: string): string => `<${iso}>`;

function status(overrides: Partial<DiagnosticStatus> = {}): DiagnosticStatus {
  return {
    state: 'errors-only',
    qualificationExpiresAt: null,
    uploadTokenExpiresAt: null,
    campaignId: null,
    enrolled: false,
    consentedAt: null,
    message: '診断収集は停止しています。',
    ...overrides,
  };
}

function enrolled(overrides: Partial<DiagnosticStatus> = {}): DiagnosticStatus {
  return status({
    qualificationExpiresAt: '2026-09-20T00:00:00.000Z',
    campaignId: 'campaign-1',
    enrolled: true,
    consentedAt: '2026-09-06T00:00:00.000Z',
    ...overrides,
  });
}

describe('buildDiagnosticPanelView', () => {
  it('asks an unenrolled tester for consent and the access code', () => {
    const view = buildDiagnosticPanelView(status(), formatDateTime);

    expect(view.consentChecked).toBeNull();
    expect(view.consentDisabled).toBe(false);
    expect(view.accessCodeDisabled).toBe(false);
    expect(view.accessCodePlaceholder).toBe('キャンペーン参加時のみ');
    expect(view.startLabel).toBe('参加して診断収集を開始');
    expect(view.startDisabled).toBe(false);
    expect(view.stopDisabled).toBe(true);
    expect(view.statusLabel).toBe('診断収集: 停止');
    expect(view.detailText).toBe('診断収集は停止しています。');
  });

  it('restores consent and suppresses the access code for an enrolled tester', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'active', message: '診断収集中です。' }),
      formatDateTime
    );

    expect(view.consentChecked).toBe(true);
    expect(view.consentDisabled).toBe(true);
    expect(view.accessCodeDisabled).toBe(true);
    expect(view.accessCodePlaceholder).toBe('参加済み・再入力不要');
    expect(view.collecting).toBe(true);
    expect(view.errored).toBe(false);
    expect(view.statusLabel).toBe('診断収集: 有効 · campaign-1');
    expect(view.startDisabled).toBe(true);
    expect(view.stopDisabled).toBe(false);
  });

  it('shows only the qualification expiry for a healthy enrolled tester', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'active', message: '診断収集中です。' }),
      formatDateTime
    );

    expect(view.detailText).toBe('資格期限: <2026-09-20T00:00:00.000Z>');
  });

  it('falls back to the campaign name when the stored qualification has no id', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'active', campaignId: null, message: '診断収集中です。' }),
      formatDateTime
    );

    expect(view.statusLabel).toBe('診断収集: 有効 · 不明');
  });

  it('keeps the full state message for the diagnostics view', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'active', message: '診断収集中です。送信tokenは自動更新されます。' }),
      formatDateTime
    );

    expect(view.message).toBe('診断収集中です。送信tokenは自動更新されます。');
  });

  it('keeps the restored participation visible while collection is paused', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'paused', message: '診断収集は一時停止中です。' }),
      formatDateTime
    );

    expect(view.consentChecked).toBe(true);
    expect(view.accessCodeDisabled).toBe(true);
    expect(view.statusLabel).toBe('診断収集: 一時停止 · campaign-1');
    expect(view.detailText).toBe('資格期限: <2026-09-20T00:00:00.000Z>');
    expect(view.startLabel).toBe('診断収集を再開');
    expect(view.startDisabled).toBe(false);
    expect(view.stopDisabled).toBe(true);
  });

  it('labels offline buffering as locally stored while still collecting', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'offline-buffering', message: 'オフラインのため端末に保存中です。' }),
      formatDateTime
    );

    expect(view.statusLabel).toBe('診断収集: 端末保存中 · campaign-1');
    expect(view.collecting).toBe(true);
    expect(view.stopDisabled).toBe(false);
  });

  it('re-opens consent and the access code once the qualification expired', () => {
    const view = buildDiagnosticPanelView(
      status({ state: 'expired', message: '参加資格の有効期限が切れています。' }),
      formatDateTime
    );

    expect(view.errored).toBe(true);
    expect(view.consentChecked).toBe(false);
    expect(view.consentDisabled).toBe(false);
    expect(view.accessCodeDisabled).toBe(false);
    expect(view.startDisabled).toBe(false);
  });

  it('clears a stale consent tick once the qualification lapsed mid-session', () => {
    const view = buildDiagnosticPanelView(
      status({ state: 'offline-buffering', campaignId: 'campaign-1', message: 'オフラインです。' }),
      formatDateTime
    );

    expect(view.consentChecked).toBe(false);
    expect(view.consentDisabled).toBe(false);
  });

  it('leaves a consent tick the tester made while a first enrollment is in flight', () => {
    const view = buildDiagnosticPanelView(
      status({ state: 'joining', message: 'キャンペーン参加資格を登録しています。' }),
      formatDateTime
    );

    expect(view.consentChecked).toBeNull();
  });

  it('blocks restarting after the qualification was revoked', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'revoked', message: '参加資格が失効しました。' }),
      formatDateTime
    );

    expect(view.errored).toBe(true);
    expect(view.startDisabled).toBe(true);
    expect(view.stopDisabled).toBe(true);
  });

  it('shows the state message instead of the expiry once an enrolled tester is revoked', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'revoked', message: '参加資格が失効しました。' }),
      formatDateTime
    );

    expect(view.statusLabel).toBe('診断収集: 停止 · campaign-1');
    expect(view.detailText).toBe('参加資格が失効しました。');
  });
});

describe('formatLocalDateTime', () => {
  it('drops seconds so the chip line stays short', () => {
    const formatted = formatLocalDateTime('2026-10-08T04:58:02.000Z');

    expect(formatted).not.toMatch(/:\d{2}:\d{2}/);
    expect(formatted).toMatch(/2026/);
  });
});
