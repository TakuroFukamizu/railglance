import type { MotionPermissionState } from '../infrastructure/sensors/device-motion-sensor-fusion-provider';

export type MotionBannerPhase = 'idle' | 'requesting' | 'just-granted';

export type MotionBannerView = {
  visible: boolean;
  message: string;
  buttonLabel: string | null;
  buttonDisabled: boolean;
};

const HIDDEN: MotionBannerView = { visible: false, message: '', buttonLabel: null, buttonDisabled: false };

export const JUST_GRANTED_VISIBLE_MS = 3000;

export function buildMotionBannerView(state: MotionPermissionState, phase: MotionBannerPhase): MotionBannerView {
  const requesting = phase === 'requesting';
  switch (state) {
    case 'granted':
      if (phase === 'just-granted') {
        return { visible: true, message: '有効化しました', buttonLabel: null, buttonDisabled: false };
      }
      return HIDDEN;
    case 'denied':
      return {
        visible: true,
        message: '許可されませんでした。端末の設定で Even App のモーションアクセスを許可してください',
        buttonLabel: '再試行',
        buttonDisabled: requesting,
      };
    case 'unsupported':
      return {
        visible: true,
        message: 'この端末ではモーションセンサーを利用できません',
        buttonLabel: null,
        buttonDisabled: false,
      };
    case 'insecure-context':
      return {
        visible: true,
        message: '安全な接続（https）でないためモーションセンサーを利用できません',
        buttonLabel: null,
        buttonDisabled: false,
      };
    case 'unknown':
    default:
      return {
        visible: true,
        message: 'モーションセンサーを有効にすると、トンネル内でも速度を推定できます',
        buttonLabel: '有効化',
        buttonDisabled: requesting,
      };
  }
}

export type MotionPermissionSource = {
  getPermissionStatus(): MotionPermissionState;
  onPermissionChange(listener: (state: MotionPermissionState) => void): () => void;
  requestPermission(): Promise<boolean>;
};

export type MotionBannerControllerDeps = {
  provider: MotionPermissionSource;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export type MotionBannerController = {
  getView(): MotionBannerView;
  request(): Promise<void>;
  subscribe(listener: (view: MotionBannerView) => void): () => void;
  dispose(): void;
};

/**
 * Small state machine behind the home banner: permission state comes from the
 * provider, the phase (idle / requesting / just-granted) lives here.
 */
export function createMotionBannerController(deps: MotionBannerControllerDeps): MotionBannerController {
  const schedule = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let phase: MotionBannerPhase = 'idle';
  let timer: unknown = null;
  let listeners: Array<(view: MotionBannerView) => void> = [];

  const view = () => buildMotionBannerView(deps.provider.getPermissionStatus(), phase);
  const emit = () => {
    const v = view();
    for (const l of [...listeners]) l(v);
  };
  const clearTimer = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };
  const setPhase = (next: MotionBannerPhase) => {
    phase = next;
    emit();
  };

  const unsubscribeProvider = deps.provider.onPermissionChange(() => emit());

  return {
    getView: view,
    async request() {
      clearTimer();
      setPhase('requesting');
      let granted = false;
      try {
        granted = await deps.provider.requestPermission();
      } catch {
        granted = false;
      }
      if (!granted) {
        setPhase('idle');
        return;
      }
      setPhase('just-granted');
      timer = schedule(() => {
        timer = null;
        setPhase('idle');
      }, JUST_GRANTED_VISIBLE_MS);
    },
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    dispose() {
      clearTimer();
      unsubscribeProvider();
      listeners = [];
    },
  };
}
