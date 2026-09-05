import type { DiagnosticStatus } from '../infrastructure/telemetry/runtime-telemetry';

export type DiagnosticPanelView = {
  statusLabel: string;
  detailText: string;
  collecting: boolean;
  errored: boolean;
  consentChecked: boolean;
  consentDisabled: boolean;
  accessCodeDisabled: boolean;
  accessCodePlaceholder: string;
  startLabel: string;
  startDisabled: boolean;
  stopDisabled: boolean;
};

const COLLECTING_STATES = ['active', 'refreshing', 'offline-buffering'];
const ERROR_STATES = ['expired', 'revoked', 'release-blocked'];
const START_BLOCKED_STATES = ['joining', 'revoked', 'release-blocked'];

export function formatLocalDateTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString();
}

function statusLabelOf(status: DiagnosticStatus, collecting: boolean): string {
  if (collecting) {
    return status.state === 'offline-buffering' ? '診断収集: 端末保存中' : '診断収集: 有効';
  }
  return status.state === 'paused' ? '診断収集: 一時停止' : '診断収集: 停止';
}

function detailTextOf(status: DiagnosticStatus, formatDateTime: (iso: string) => string): string {
  if (!status.enrolled) return status.message;
  const parts = [`参加済み: ${status.campaignId ?? '不明'}`];
  if (status.consentedAt) parts.push(`同意: ${formatDateTime(status.consentedAt)}`);
  if (status.qualificationExpiresAt) {
    parts.push(`資格期限: ${formatDateTime(status.qualificationExpiresAt)}`);
  }
  return `${status.message} ${parts.join(' / ')}`;
}

/**
 * Maps the persisted diagnostic participation state onto the tester panel so a
 * restored qualification stays visible after a restart without re-entering the code.
 */
export function buildDiagnosticPanelView(
  status: DiagnosticStatus,
  formatDateTime: (iso: string) => string = formatLocalDateTime
): DiagnosticPanelView {
  const collecting = COLLECTING_STATES.includes(status.state);
  return {
    statusLabel: statusLabelOf(status, collecting),
    detailText: detailTextOf(status, formatDateTime),
    collecting,
    errored: ERROR_STATES.includes(status.state),
    consentChecked: status.enrolled,
    consentDisabled: status.enrolled,
    accessCodeDisabled: status.enrolled,
    accessCodePlaceholder: status.enrolled ? '参加済み・再入力不要' : 'キャンペーン参加時のみ',
    startLabel: status.state === 'paused' ? '診断収集を再開' : '参加して診断収集を開始',
    startDisabled: collecting || START_BLOCKED_STATES.includes(status.state),
    stopDisabled: !collecting,
  };
}
