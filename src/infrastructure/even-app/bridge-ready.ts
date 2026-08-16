import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';

/**
 * Upper bound for the SDK bridge handshake.
 *
 * The WebView pushes the bridge once page loading completes, so this only needs
 * to be generous enough to cover a slow start-up. Paired with AppController's
 * backoff (max 10s) it retries roughly every 20s while the bridge is absent.
 */
export const DEFAULT_BRIDGE_READY_TIMEOUT_MS = 10_000;

/**
 * Largest delay `setTimeout` can actually hold (2^31 - 1 ms, ~24.9 days).
 *
 * Anything above it overflows the 32-bit timer and fires after ~1ms instead,
 * so a caller asking for a very long wait would silently get an instant one.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Resolves a caller-supplied handshake bound to a delay `setTimeout` can honour.
 *
 * `setTimeout` never rejects a bad delay, it quietly substitutes 1ms:
 * `Infinity`, `NaN` and negatives all fire on the next tick. Passing one
 * through would not restore the unbounded wait this bound exists to prevent —
 * it causes the opposite failure, a handshake that expires before the bridge
 * can ever answer, leaving the caller permanently unable to connect. Values
 * over {@link MAX_TIMER_DELAY_MS} overflow into the same instant-fire
 * behaviour, so they are clamped rather than rejected.
 *
 * @param logPrefix Owner tag for the warning, e.g. `[EvenG2Adapter]`.
 */
export function resolveBridgeReadyTimeoutMs(
  value: number | undefined,
  logPrefix: string
): number {
  if (value === undefined) return DEFAULT_BRIDGE_READY_TIMEOUT_MS;

  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `${logPrefix} Ignoring invalid bridgeReadyTimeoutMs (${value}); ` +
        `falling back to ${DEFAULT_BRIDGE_READY_TIMEOUT_MS}ms.`
    );
    return DEFAULT_BRIDGE_READY_TIMEOUT_MS;
  }

  if (value > MAX_TIMER_DELAY_MS) {
    console.warn(
      `${logPrefix} Clamping bridgeReadyTimeoutMs (${value}) to ` +
        `${MAX_TIMER_DELAY_MS}ms, the longest delay setTimeout can hold.`
    );
    return MAX_TIMER_DELAY_MS;
  }

  return value;
}

/**
 * Bounded wrapper around the SDK handshake.
 *
 * `waitForEvenAppBridge()` resolves on an `evenAppBridgeReady` event and the SDK
 * exposes no timeout, so a bridge that never initializes parks the caller
 * forever: retry loops never iterate again and `await`ed start-up paths never
 * settle, leaving no log and no error. Bounding it turns that silent stall into
 * an ordinary failure that backoff can retry and error reporting can observe.
 *
 * The losing side of the race is abandoned rather than cancelled — the SDK has
 * no cancellation — so a bridge that shows up late is dropped instead of being
 * wired up behind whatever fallback has since taken over.
 *
 * @param timeoutMs Must already be a delay `setTimeout` can honour; run
 *   caller-supplied values through {@link resolveBridgeReadyTimeoutMs} first.
 */
export async function waitForEvenAppBridgeWithin(timeoutMs: number): Promise<EvenAppBridge> {
  const pending = waitForEvenAppBridge();
  // Promise.race already handles a late settle, but keep this explicit so the
  // abandoned SDK promise can never surface as an unhandled rejection.
  void pending.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`waitForEvenAppBridge() timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([pending, expiry]);
  } finally {
    clearTimeout(timer);
  }
}
