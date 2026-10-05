/**
 * Exponential backoff with jitter for `NexaIMClient` reconnect attempts.
 *
 * Formula:
 *   raw  = min(maxMs, baseMs * factor^attempt)
 *   jitter range = [raw * (1 - jitterRatio), raw * (1 + jitterRatio)]
 *   return round(uniform(jitter range))
 *
 * Defaults follow common backoff patterns:
 *   baseMs=500, maxMs=10_000, factor=2, jitterRatio=0.2
 *
 * `jitterRatio = 0` makes the function deterministic and is useful for tests
 * that need to assert specific schedule values.
 */

export type CreateReconnectDelayOptions = {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  jitterRatio?: number;
};

export function createReconnectDelay(
  attempt: number,
  options: CreateReconnectDelayOptions = {}
): number {
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 10_000;
  const factor = options.factor ?? 2;
  const jitterRatio = options.jitterRatio ?? 0.2;

  if (!Number.isFinite(attempt) || attempt < 0) {
    return 0;
  }
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    return 0;
  }
  if (!Number.isFinite(maxMs) || maxMs <= 0) {
    return 0;
  }
  if (!Number.isFinite(factor) || factor <= 1) {
    return Math.round(baseMs);
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0) {
    return Math.round(baseMs);
  }

  const safeAttempt = Math.floor(attempt);
  const exp = Math.pow(factor, safeAttempt);
  const raw = Math.min(maxMs, baseMs * exp);

  if (jitterRatio === 0) {
    return Math.round(raw);
  }

  const jitterRange = raw * jitterRatio;
  const minJitter = raw - jitterRange;
  const maxJitter = raw + jitterRange;
  return Math.round(minJitter + Math.random() * (maxJitter - minJitter));
}