/** A rule that belongs to one channel or thread of one guild. */
export interface ChannelRule {
  guildId: string;
  channelId: string;
}

/** The rules of every guild a module runs in, so messages are checked against memory and never against the database. */
export class ChannelRuleIndex<T extends ChannelRule> {
  private readonly guilds = new Map<string, Map<string, T>>();

  /** Replaces the rules of one guild. */
  replaceGuild(guildId: string, rules: T[]): void {
    this.dropGuild(guildId);
    for (const rule of rules) this.set(rule);
  }

  dropGuild(guildId: string): void {
    this.guilds.delete(guildId);
  }

  set(rule: T): void {
    let rules = this.guilds.get(rule.guildId);
    if (rules === undefined) {
      rules = new Map();
      this.guilds.set(rule.guildId, rules);
    }
    rules.set(rule.channelId, rule);
  }

  delete(guildId: string, channelId: string): void {
    this.guilds.get(guildId)?.delete(channelId);
  }

  get(guildId: string, channelId: string): T | undefined {
    return this.guilds.get(guildId)?.get(channelId);
  }

  /** The rules of one guild. */
  rulesOf(guildId: string): IterableIterator<T> {
    return this.guilds.get(guildId)?.values() ?? [][Symbol.iterator]();
  }
}
