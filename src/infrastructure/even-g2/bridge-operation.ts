export type BridgeOperationKind =
  | 'text-header'
  | 'text-segment'
  | 'text-footer'
  | 'speed-image'
  | 'page-create'
  | 'page-recover'
  | 'page-shutdown';

export type BridgeTransportStatus = 'DISCONNECTED' | 'CONNECTED' | 'STALLED' | 'RECOVERING';

export type BridgeRecoveryReason = 'foreground-enter' | 'transport-stall';

export type BridgeOperationState = {
  sequence: number;
  currentOperation: BridgeOperationKind | null;
  currentStartedAtMs: number | null;
  lastCompletedOperation: BridgeOperationKind | null;
  lastCompletedAtMs: number | null;
  lastElapsedMs: number | null;
  lastResult: string | null;
  lastError: string | null;
  stalled: boolean;
};

export type BridgeDiagnosticsSnapshot = {
  status: BridgeTransportStatus;
  pageReady: boolean;
  sessionEpoch: number;
  operation: BridgeOperationState;
  operationAgeMs: number | null;
  lastImageResult: string;
  lastImageCompletedAtMs: number | null;
  renderGeneration: number;
  flushedGeneration: number;
  hudFlushScheduled: boolean;
  hudFlushInFlight: boolean;
  hudDirty: boolean;
  recoveryCount: number;
  stallRecoveryFailures: number;
  lastRecoveryReason: string | null;
  lastRecoveryAtMs: number | null;
};

export const DEFAULT_TEXT_OPERATION_TIMEOUT_MS = 5_000;
export const DEFAULT_IMAGE_OPERATION_TIMEOUT_MS = 8_000;
export const DEFAULT_PAGE_OPERATION_TIMEOUT_MS = 10_000;
export const DEFAULT_TEXT_SLOW_WARN_MS = 1_000;
export const DEFAULT_IMAGE_SLOW_WARN_MS = 3_000;
/** Bounded wait for a stalled native op to settle before recovery issues new BLE traffic. */
export const DEFAULT_STALL_SETTLE_GRACE_MS = 2_000;

export const STALL_RECOVERY_BACKOFF_MS = [0, 1_000, 3_000] as const;
export const RECOVERY_HEALTH_RESET_MS = 60_000;

export function emptyBridgeOperationState(): BridgeOperationState {
  return {
    sequence: 0,
    currentOperation: null,
    currentStartedAtMs: null,
    lastCompletedOperation: null,
    lastCompletedAtMs: null,
    lastElapsedMs: null,
    lastResult: null,
    lastError: null,
    stalled: false,
  };
}
