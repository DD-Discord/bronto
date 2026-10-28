import { ChannelRuleIndex } from '@bronto/core';
import type { Rule } from './db/schema.js';

/** The rules of every guild the module runs in. */
export class RuleIndex extends ChannelRuleIndex<Rule> {
  /** Whether the webhook is the log webhook of a rule in the guild. */
  isLogWebhook(guildId: string, webhookId: string): boolean {
    for (const rule of this.rulesOf(guildId)) if (rule.logWebhookId === webhookId) return true;
    return false;
  }
}
