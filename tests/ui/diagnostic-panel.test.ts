import { describe, expect, it } from 'vitest';
import { buildDiagnosticPanelView } from '../../src/ui/diagnostic-panel';
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

    expect(view.consentChecked).toBe(false);
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
    expect(view.statusLabel).toBe('診断収集: 有効');
    expect(view.startDisabled).toBe(true);
    expect(view.stopDisabled).toBe(false);
  });

  it('reports the stored participation details for an enrolled tester', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'active', message: '診断収集中です。' }),
      formatDateTime
    );

    expect(view.detailText).toBe(
      '診断収集中です。 参加済み: campaign-1 / 同意: <2026-09-06T00:00:00.000Z>'
      + ' / 資格期限: <2026-09-20T00:00:00.000Z>'
    );
  });

  it('keeps the restored participation visible while collection is paused', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'paused', message: '診断収集は一時停止中です。' }),
      formatDateTime
    );

    expect(view.consentChecked).toBe(true);
    expect(view.accessCodeDisabled).toBe(true);
    expect(view.statusLabel).toBe('診断収集: 一時停止');
    expect(view.startLabel).toBe('診断収集を再開');
    expect(view.startDisabled).toBe(false);
    expect(view.stopDisabled).toBe(true);
  });

  it('labels offline buffering as locally stored while still collecting', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'offline-buffering', message: 'オフラインのため端末に保存中です。' }),
      formatDateTime
    );

    expect(view.statusLabel).toBe('診断収集: 端末保存中');
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

  it('blocks restarting after the qualification was revoked', () => {
    const view = buildDiagnosticPanelView(
      enrolled({ state: 'revoked', message: '参加資格が失効しました。' }),
      formatDateTime
    );

    expect(view.errored).toBe(true);
    expect(view.startDisabled).toBe(true);
    expect(view.stopDisabled).toBe(true);
  });
});
