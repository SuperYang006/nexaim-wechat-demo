/**
 * Generate a client-side request id for outgoing `ClientWsMessage` frames.
 *
 * The WebSocket protocol schema (`packages/protocol/src/ws.ts`) constrains
 * `requestId` to a non-empty string of at most 128 characters. This helper
 * produces ids in the form `<prefix>-<uuid>` (or a non-UUID fallback when
 * `crypto.randomUUID` is unavailable) and falls back to truncating the
 * suffix if the chosen prefix pushes the result past the 128-char ceiling.
 */

export const REQUEST_ID_MAX_LENGTH = 128;

function generateSuffix(): string {
  const cryptoObj =
    typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createRequestId(prefix: string = "req"): string {
  const safePrefix = prefix.length > 0 ? prefix : "req";
  const suffix = generateSuffix();
  const combined = `${safePrefix}-${suffix}`;
  if (combined.length <= REQUEST_ID_MAX_LENGTH) {
    return combined;
  }
  // prefix 过长导致溢出 —— 截断 suffix 而不是 prefix，避免两个不同 caller
  // 共享同一 prefix 时撞 id。
  const overflow = combined.length - REQUEST_ID_MAX_LENGTH;
  return combined.slice(0, combined.length - overflow);
}