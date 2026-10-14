import { AsyncLocalStorage } from 'node:async_hooks';

/** The guild and acting user the current code runs for; read by the database layer. */
export interface Scope {
  guildId: string | null;
  actorId: string | null;
}

const storage = new AsyncLocalStorage<Scope>();

/** Runs `fn` with `patch` overriding fields of the current scope. */
export function runInScope<T>(patch: Partial<Scope>, fn: () => T): T {
  const current = storage.getStore() ?? { guildId: null, actorId: null };
  return storage.run({ ...current, ...patch }, fn);
}

export function currentGuildId(): string | null {
  return storage.getStore()?.guildId ?? null;
}

export function currentActor(): string | null {
  return storage.getStore()?.actorId ?? null;
}
