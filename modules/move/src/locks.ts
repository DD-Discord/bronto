/**
 * In-memory locks per channel ID. Waiters get a lock in the order they asked for it, and `acquire` takes its keys in
 * sorted order, so two moves sharing channels can't deadlock.
 */
export class ChannelLocks {
  /** Present while a key is held; the entries are the waiters, first in line first. */
  private readonly queues = new Map<string, (() => void)[]>();

  /** Resolves with the release once every key is held; `onWait` runs once when it has to wait. */
  async acquire(ids: string[], onWait: () => void): Promise<() => void> {
    const keys = [...new Set(ids)].sort();
    let waited = false;
    for (const key of keys) {
      const queue = this.queues.get(key);
      if (queue === undefined) {
        this.queues.set(key, []);
        continue;
      }
      if (!waited) {
        waited = true;
        onWait();
      }
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) this.release(key);
    };
  }

  /** Hands the key to the next waiter, or frees it. */
  private release(key: string): void {
    const next = this.queues.get(key)?.shift();
    if (next === undefined) this.queues.delete(key);
    else next();
  }
}
