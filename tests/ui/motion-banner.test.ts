import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMotionBannerView,
  createMotionBannerController,
  type MotionBannerView,
} from '../../src/ui/motion-banner';
import type { MotionPermissionState } from '../../src/infrastructure/sensors/device-motion-sensor-fusion-provider';

describe('buildMotionBannerView', () => {
  it('invites the user while unknown', () => {
    const view = buildMotionBannerView('unknown', 'idle');
    expect(view.visible).toBe(true);
    expect(view.message).toContain('トンネル内でも速度を推定');
    expect(view.buttonLabel).toBe('有効化');
    expect(view.buttonDisabled).toBe(false);
  });

  it('disables the button while requesting and keeps the wording', () => {
    expect(buildMotionBannerView('unknown', 'requesting')).toEqual({
      ...buildMotionBannerView('unknown', 'idle'),
      buttonDisabled: true,
    });
    expect(buildMotionBannerView('denied', 'requesting').buttonDisabled).toBe(true);
  });

  it('hides when granted at idle and confirms when just granted', () => {
    expect(buildMotionBannerView('granted', 'idle').visible).toBe(false);
    const view = buildMotionBannerView('granted', 'just-granted');
    expect(view.visible).toBe(true);
    expect(view.message).toBe('有効化しました');
    expect(view.buttonLabel).toBeNull();
  });

  it('offers a retry when denied', () => {
    const view = buildMotionBannerView('denied', 'idle');
    expect(view.visible).toBe(true);
    expect(view.message).toContain('許可されませんでした');
    expect(view.buttonLabel).toBe('再試行');
  });

  it.each<[MotionPermissionState, string]>([
    ['unsupported', 'この端末ではモーションセンサーを利用できません'],
    ['insecure-context', '安全な接続（https）でないためモーションセンサーを利用できません'],
  ])('explains %s without a button', (state, message) => {
    const view = buildMotionBannerView(state, 'idle');
    expect(view.visible).toBe(true);
    expect(view.message).toBe(message);
    expect(view.buttonLabel).toBeNull();
  });
});

describe('createMotionBannerController', () => {
  type FakeProvider = {
    state: MotionPermissionState;
    listeners: Array<(s: MotionPermissionState) => void>;
    getPermissionStatus(): MotionPermissionState;
    onPermissionChange(cb: (s: MotionPermissionState) => void): () => void;
    requestPermission: () => Promise<boolean>;
    set(next: MotionPermissionState): void;
  };

  function fakeProvider(initial: MotionPermissionState, result: MotionPermissionState): FakeProvider {
    const provider: FakeProvider = {
      state: initial,
      listeners: [],
      getPermissionStatus: () => provider.state,
      onPermissionChange(cb) {
        provider.listeners.push(cb);
        return () => {
          provider.listeners = provider.listeners.filter((l) => l !== cb);
        };
      },
      requestPermission: async () => {
        // Defer like a real permission prompt so the requesting phase is observable.
        await Promise.resolve();
        provider.set(result);
        return result === 'granted';
      },
      set(next) {
        provider.state = next;
        provider.listeners.forEach((l) => l(next));
      },
    };
    return provider;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is hidden from the start when already granted', () => {
    const controller = createMotionBannerController({ provider: fakeProvider('granted', 'granted') });
    expect(controller.getView().visible).toBe(false);
  });

  it('shows the confirmation for three seconds after a grant, then hides', async () => {
    const controller = createMotionBannerController({ provider: fakeProvider('unknown', 'granted') });
    const views: MotionBannerView[] = [];
    controller.subscribe((v) => views.push(v));

    const pending = controller.request();
    expect(controller.getView().buttonDisabled).toBe(true);
    await pending;
    expect(controller.getView()).toMatchObject({ visible: true, message: '有効化しました' });

    vi.advanceTimersByTime(2999);
    expect(controller.getView().visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controller.getView().visible).toBe(false);
    expect(views.at(-1)?.visible).toBe(false);
  });

  it('returns to idle with the denial wording when denied', async () => {
    const controller = createMotionBannerController({ provider: fakeProvider('unknown', 'denied') });
    await controller.request();
    expect(controller.getView()).toMatchObject({ visible: true, buttonLabel: '再試行', buttonDisabled: false });
  });

  it('restarts the timer when granted again during the confirmation', async () => {
    const provider = fakeProvider('unknown', 'granted');
    const controller = createMotionBannerController({ provider });
    await controller.request();
    vi.advanceTimersByTime(2000);
    provider.state = 'unknown';
    await controller.request();
    vi.advanceTimersByTime(2000);
    expect(controller.getView().visible).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(controller.getView().visible).toBe(false);
  });

  it('reflects a late promotion to granted from the provider', () => {
    const provider = fakeProvider('denied', 'denied');
    const controller = createMotionBannerController({ provider });
    expect(controller.getView().visible).toBe(true);
    provider.set('granted');
    expect(controller.getView().visible).toBe(false);
  });

  it('dispose unsubscribes and clears the timer', async () => {
    const provider = fakeProvider('unknown', 'granted');
    const controller = createMotionBannerController({ provider });
    await controller.request();
    controller.dispose();
    expect(provider.listeners).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
