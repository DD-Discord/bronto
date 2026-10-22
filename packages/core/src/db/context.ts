import { AsyncLocalStorage } from 'node:async_hooks';

/** The guild and acting user the current code runs for; read by the database layer. */
export interface Scope {
  guildId: string | null;
  actorId: string | null;
  /** Deliveries waiting for the current transaction to commit; null outside a transaction. */
  pendingEvents: PendingEvents | null;
}

/** The deliveries of one transaction: an emit while `open` goes with the transaction; after it settled, it runs at once. */
export interface PendingEvents {
  deliveries: Array<() => void>;
  open: boolean;
}

const storage = new AsyncLocalStorage<Scope>();

/** Runs `fn` with `patch` overriding fields of the current scope. */
export function runInScope<T>(patch: Partial<Scope>, fn: () => T): T {
  const current = storage.getStore() ?? { guildId: null, actorId: null, pendingEvents: null };
  return storage.run({ ...current, ...patch }, fn);
}

export function currentGuildId(): string | null {
  return storage.getStore()?.guildId ?? null;
}

export function currentActor(): string | null {
  return storage.getStore()?.actorId ?? null;
}

/** Runs `deliver` after the current transaction commits, or now when there is none. */
export function afterCommit(deliver: () => void): void {
  const pending = storage.getStore()?.pendingEvents ?? null;
  // Work that outlives its transaction counts as running outside one.
  if (pending === null || !pending.open) deliver();
  else pending.deliveries.push(deliver);
}

/** Whether the current code runs inside an open `ctx.db.run` transaction. */
export function inTransaction(): boolean {
  return storage.getStore()?.pendingEvents?.open === true;
}
