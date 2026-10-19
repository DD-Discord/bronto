import { describe, expect, it } from 'vitest';
import type { Rule } from './db/schema.js';
import { RuleIndex } from './rule-index.js';

const rule = (guildId: string, channelId: string): Rule => ({ guildId, channelId, enabled: true }) as Rule;

describe('RuleIndex', () => {
  it('keeps the rules of each server apart', () => {
    const index = new RuleIndex();
    index.set(rule('g1', 'c1'));
    index.set(rule('g2', 'c1'));
    index.delete('g1', 'c1');
    expect(index.get('g1', 'c1')).toBeUndefined();
    expect(index.get('g2', 'c1')).toBeDefined();
  });

  it('replaces and drops the rules of one server only', () => {
    const index = new RuleIndex();
    index.set(rule('g1', 'c1'));
    index.set(rule('g2', 'c2'));
    index.replaceGuild('g1', [rule('g1', 'c3')]);
    expect(index.get('g1', 'c1')).toBeUndefined();
    expect(index.get('g1', 'c3')).toBeDefined();
    index.dropGuild('g1');
    expect(index.get('g1', 'c3')).toBeUndefined();
    expect(index.get('g2', 'c2')).toBeDefined();
  });
});
