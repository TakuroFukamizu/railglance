import type { DiagnosticStatus } from '../infrastructure/telemetry/runtime-telemetry';

export type DiagnosticPanelView = {
  /** Chip line 1: collection state, plus the campaign once enrolled. */
  statusLabel: string;
  /** Chip line 2: the qualification expiry while healthy, otherwise the state message. */
  detailText: string;
  /** Full state message, shown on the diagnostics view where there is room for it. */
  message: string;
  collecting: boolean;
  errored: boolean;
  /** true/false force the box; null leaves the tester's own tick untouched. */
  consentChecked: boolean | null;
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
/** States a tester can sit in before any qualification exists, where their own tick must survive. */
const PRE_ENROLLMENT_STATES = ['errors-only', 'joining'];

/** Minute precision: the chip has one line for this and seconds never matter to a tester. */
export function formatLocalDateTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function consentCheckedOf(status: DiagnosticStatus): boolean | null {
  if (status.enrolled) return true;
  return PRE_ENROLLMENT_STATES.includes(status.state) ? null : false;
}

function stateLabelOf(status: DiagnosticStatus, collecting: boolean): string {
  if (collecting) return status.state === 'offline-buffering' ? '端末保存中' : '有効';
  return status.state === 'paused' ? '一時停止' : '停止';
}

function statusLabelOf(status: DiagnosticStatus, collecting: boolean): string {
  const label = `診断収集: ${stateLabelOf(status, collecting)}`;
  return status.enrolled ? `${label} · ${status.campaignId ?? '不明'}` : label;
}

/**
 * The chip only has one line for this. While enrollment is healthy the state
 * label already says everything the message would, so the expiry (the one
 * thing a tester may need to act on) wins; any other state keeps its message.
 */
function detailTextOf(
  status: DiagnosticStatus,
  errored: boolean,
  formatDateTime: (iso: string) => string
): string {
  if (status.enrolled && !errored && status.qualificationExpiresAt) {
    return `資格期限: ${formatDateTime(status.qualificationExpiresAt)}`;
  }
  return status.message;
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
  const errored = ERROR_STATES.includes(status.state);
  return {
    statusLabel: statusLabelOf(status, collecting),
    detailText: detailTextOf(status, errored, formatDateTime),
    message: status.message,
    collecting,
    errored,
    consentChecked: consentCheckedOf(status),
    consentDisabled: status.enrolled,
    accessCodeDisabled: status.enrolled,
    accessCodePlaceholder: status.enrolled ? '参加済み・再入力不要' : 'キャンペーン参加時のみ',
    startLabel: status.state === 'paused' ? '診断収集を再開' : '参加して診断収集を開始',
    startDisabled: collecting || START_BLOCKED_STATES.includes(status.state),
    stopDisabled: !collecting,
  };
}
