/**
 * FIFO-set-based deduplication for inbound `serverMessageId` values.
 *
 * Used by `NexaIMClient` to:
 *  - drop duplicate `message.received` pushes;
 *  - suppress re-emitted `message` events when the same `serverMessageId`
 *    arrives via both `message.received` and `syncConversation` results.
 *
 * Eviction policy: when `seen()` is called and the set is at `maxSize`,
 * the OLDEST inserted id (first value in iteration order) is removed
 * before the new id is added. This is a simple FIFO strategy — no LRU
 * timestamps, no frequency counts — to keep the data structure cheap
 * for `O(1)` lookups during normal operation.
 */

export const DEFAULT_DEDUPE_MAX_SIZE = 1000;

export class MessageDedupe {
  private readonly seenIds = new Set<string>();
  private readonly maxSize: number;

  constructor(maxSize: number = DEFAULT_DEDUPE_MAX_SIZE) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new RangeError(
        `MessageDedupe maxSize must be a positive integer, got ${maxSize}`
      );
    }
    this.maxSize = maxSize;
  }

  /**
   * Record `serverMessageId` and return whether it was already seen.
   *
   * Returns `true` when the id was already in the set (caller should
   * suppress the duplicate), `false` when this is a fresh sighting
   * (caller may proceed to process the message).
   */
  seen(serverMessageId: string): boolean {
    if (this.seenIds.has(serverMessageId)) {
      return true;
    }

    if (this.seenIds.size >= this.maxSize) {
      const oldest = this.seenIds.values().next().value as string | undefined;
      if (oldest !== undefined) {
        this.seenIds.delete(oldest);
      }
    }
    this.seenIds.add(serverMessageId);
    return false;
  }

  /**
   * Total ids currently tracked. Exposed for tests + diagnostics.
   */
  get size(): number {
    return this.seenIds.size;
  }

  /**
   * Effective eviction ceiling.
   */
  get capacity(): number {
    return this.maxSize;
  }

  /**
   * Drop all tracked ids. Used by `NexaIMClient.disconnect()` when
   * reconnecting from scratch should NOT replay already-seen messages.
   */
  clear(): void {
    this.seenIds.clear();
  }
}