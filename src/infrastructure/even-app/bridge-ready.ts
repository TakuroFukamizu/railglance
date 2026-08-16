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

let pendingHandshake: Promise<EvenAppBridge> | null = null;

/**
 * One shared handshake for all attempts.
 *
 * `waitForEvenAppBridge()` registers a one-shot `evenAppBridgeReady` listener per
 * call and the SDK offers no cancellation, so a timed-out attempt cannot take its
 * listener back. Calling the SDK again per retry would strand one listener — plus
 * its closure and pending promise — on `window` every time, growing without bound
 * for as long as the bridge stays absent.
 *
 * Sharing one handshake also makes a late bridge usable: the listener from the
 * first attempt is still armed, so whichever attempt is waiting when the bridge
 * finally arrives resolves with it.
 */
function sharedHandshake(): Promise<EvenAppBridge> {
  const existing = pendingHandshake;
  if (existing) return existing;

  const started = waitForEvenAppBridge();
  // A rejected handshake must not stay cached, or every later attempt would
  // replay the same failure without ever asking the SDK again.
  void started.catch(() => {
    if (pendingHandshake === started) pendingHandshake = null;
  });
  pendingHandshake = started;
  return started;
}

/**
 * Drops the shared handshake.
 *
 * Only for tests: production code has a single bridge per page, so the cache is
 * meant to live for the lifetime of the document.
 */
export function resetBridgeHandshakeForTests(): void {
  pendingHandshake = null;
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
 * A timed-out attempt abandons the race but not the handshake: the SDK has no
 * cancellation, so the underlying wait is kept and reused (see
 * {@link sharedHandshake}) rather than restarted. A bridge that shows up late is
 * therefore picked up by the next attempt instead of being lost.
 *
 * @param timeoutMs Must already be a delay `setTimeout` can honour; run
 *   caller-supplied values through {@link resolveBridgeReadyTimeoutMs} first.
 */
export async function waitForEvenAppBridgeWithin(timeoutMs: number): Promise<EvenAppBridge> {
  // Shared across attempts so retrying cannot accumulate SDK listeners.
  const pending = sharedHandshake();

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
