type Task = () => Promise<void>;

export type QueueErrorHandler = (key: string, error: unknown) => void;

interface Request {
  task: Task;
  waiters: Array<() => void>;
}

interface Slot {
  pending: Request | null;
}

/**
 * Serializes work per key: at most one task runs per key and at most one waits behind it. A newer request replaces
 * the waiting one, so a burst collapses into the running task plus one follow-up.
 */
export class KeyedQueue {
  private readonly slots = new Map<string, Slot>();
  private readonly draining = new Set<Promise<void>>();
  private readonly onError: QueueErrorHandler;

  /** `onError` receives the errors of failed tasks; errors it throws are ignored. */
  constructor(onError: QueueErrorHandler) {
    this.onError = onError;
  }

  /** Resolves once this task, or a newer task that replaced it while waiting, has finished. Never rejects. */
  run(key: string, task: Task): Promise<void> {
    return new Promise((resolve) => {
      const slot = this.slots.get(key);
      if (slot === undefined) {
        const created: Slot = { pending: null };
        this.slots.set(key, created);
        const drained = this.drain(key, created, { task, waiters: [resolve] });
        this.draining.add(drained);
        void drained.then(() => this.draining.delete(drained));
      } else if (slot.pending === null) {
        slot.pending = { task, waiters: [resolve] };
      } else {
        slot.pending.task = task;
        slot.pending.waiters.push(resolve);
      }
    });
  }

  /** Resolves once no key has running or waiting work. */
  async idle(): Promise<void> {
    while (this.draining.size > 0) {
      await Promise.all([...this.draining]);
    }
  }

  private async drain(key: string, slot: Slot, first: Request): Promise<void> {
    let request: Request | null = first;
    while (request !== null) {
      try {
        await request.task();
      } catch (error) {
        try {
          this.onError(key, error);
        } catch {
          // A throwing error handler must not leave the key stuck.
        }
      }
      for (const resolve of request.waiters) resolve();
      request = slot.pending;
      slot.pending = null;
    }
    this.slots.delete(key);
  }
}
