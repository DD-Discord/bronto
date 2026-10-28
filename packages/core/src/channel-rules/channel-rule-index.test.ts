import { describe, expect, it } from 'vitest';
import { ChannelRuleIndex } from './channel-rule-index.js';

const rule = (guildId: string, channelId: string, note = '') => ({ guildId, channelId, note });

describe('ChannelRuleIndex', () => {
  it('keeps rules per guild and channel', () => {
    const index = new ChannelRuleIndex<ReturnType<typeof rule>>();
    index.set(rule('g1', 'c1'));
    index.set(rule('g2', 'c1', 'other'));
    expect(index.get('g1', 'c1')?.note).toBe('');
    expect(index.get('g2', 'c1')?.note).toBe('other');
    expect(index.get('g1', 'c2')).toBeUndefined();
    expect(index.get('g3', 'c1')).toBeUndefined();
  });

  it('replaces a rule of the same channel', () => {
    const index = new ChannelRuleIndex<ReturnType<typeof rule>>();
    index.set(rule('g1', 'c1', 'a'));
    index.set(rule('g1', 'c1', 'b'));
    expect([...index.rulesOf('g1')]).toEqual([rule('g1', 'c1', 'b')]);
  });

  it('deletes one rule', () => {
    const index = new ChannelRuleIndex<ReturnType<typeof rule>>();
    index.set(rule('g1', 'c1'));
    index.set(rule('g1', 'c2'));
    index.delete('g1', 'c1');
    index.delete('g9', 'c1');
    expect([...index.rulesOf('g1')].map((r) => r.channelId)).toEqual(['c2']);
  });

  it('replaces and drops the rules of one guild only', () => {
    const index = new ChannelRuleIndex<ReturnType<typeof rule>>();
    index.set(rule('g1', 'c1'));
    index.set(rule('g2', 'c1'));
    index.replaceGuild('g1', [rule('g1', 'c5')]);
    expect([...index.rulesOf('g1')].map((r) => r.channelId)).toEqual(['c5']);
    index.dropGuild('g1');
    expect([...index.rulesOf('g1')]).toEqual([]);
    expect([...index.rulesOf('g2')]).toHaveLength(1);
  });
});
