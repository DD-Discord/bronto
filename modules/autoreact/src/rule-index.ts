import type { Rule } from './db/schema.js';

/** The rules of every guild the module runs in; messages are checked against these, never against the database. */
export class RuleIndex {
  private readonly rules = new Map<string, Rule>();

  private static keyOf(guildId: string, channelId: string): string {
    return `${guildId}/${channelId}`;
  }

  /** Replaces the rules of one guild. */
  replaceGuild(guildId: string, rules: Rule[]): void {
    this.dropGuild(guildId);
    for (const rule of rules) this.set(rule);
  }

  dropGuild(guildId: string): void {
    for (const [key, rule] of this.rules) if (rule.guildId === guildId) this.rules.delete(key);
  }

  set(rule: Rule): void {
    this.rules.set(RuleIndex.keyOf(rule.guildId, rule.channelId), rule);
  }

  delete(guildId: string, channelId: string): void {
    this.rules.delete(RuleIndex.keyOf(guildId, channelId));
  }

  get(guildId: string, channelId: string): Rule | undefined {
    return this.rules.get(RuleIndex.keyOf(guildId, channelId));
  }
}
