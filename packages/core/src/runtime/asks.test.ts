import { describe, expect, it } from 'vitest';
import { answer, defineAsk, type AskStrategy } from './asks.js';
import { defineGate, gate } from './gates.js';
import { defineModule } from './module.js';

const strategy: AskStrategy<string[], string[]> = {
  timeoutMs: 100,
  initial: () => [],
  next: (state, outcome) => ({ state: [...state, outcome.kind] }),
  finish: (state) => state,
};

describe('asks', () => {
  it('sets the owner when a module declares the ask', () => {
    const ask = defineAsk<string, number, string[]>('x', strategy);
    expect(ask.owner).toBeNull();
    defineModule({ name: 'first', asks: { x: ask } });
    expect(ask.owner).toBe('first');
  });

  it('rejects an ask another module owns', () => {
    const ask = defineAsk<string, number, string[]>('x', strategy);
    defineModule({ name: 'first', asks: { x: ask } });
    expect(() => defineModule({ name: 'second', asks: { x: ask } })).toThrow('Ask "x" already belongs to module "first".');
  });

  it('builds an ask listener with answer()', () => {
    const ask = defineAsk<string, number, string[]>('x', strategy);
    const handler = () => 1;
    expect(answer(ask, handler)).toEqual({ kind: 'ask', ask, handler });
  });

  it('builds gates on top of asks', () => {
    const definition = defineGate('d');
    expect(gate(definition, () => undefined).kind).toBe('ask');
    expect(definition.strategy.timeoutMs).toBe(5000);
  });
});
