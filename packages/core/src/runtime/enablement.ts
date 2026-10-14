import { eq } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { guildModules } from '../db/schema.js';

/**
 * Which modules are switched off in which guild, cached per guild. Modules are enabled unless a guild switched
 * them off, so a guild without stored switches needs no rows.
 */
export class ModuleEnablement {
  private readonly admin: Db;
  private readonly cache = new Map<string, Map<string, boolean>>();

  constructor(admin: Db) {
    this.admin = admin;
  }

  async load(guildId: string): Promise<void> {
    const rows = await this.admin
      .select({ module: guildModules.module, enabled: guildModules.enabled })
      .from(guildModules)
      .where(eq(guildModules.guildId, guildId));
    this.cache.set(guildId, new Map(rows.map((row) => [row.module, row.enabled])));
  }

  isEnabled(guildId: string, module: string): boolean {
    return this.cache.get(guildId)?.get(module) ?? true;
  }

  async set(guildId: string, module: string, enabled: boolean): Promise<void> {
    await this.admin
      .insert(guildModules)
      .values({ guildId, module, enabled })
      .onConflictDoUpdate({ target: [guildModules.guildId, guildModules.module], set: { enabled } });
    if (this.cache.has(guildId)) {
      // Guild already loaded, just update this switch
      this.cache.get(guildId)!.set(module, enabled);
    } else {
      // Guild not loaded yet, load all switches including the one just written
      await this.load(guildId);
    }
  }

  forget(guildId: string): void {
    this.cache.delete(guildId);
  }
}
