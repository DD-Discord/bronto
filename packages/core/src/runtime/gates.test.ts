import { describe, expect, it } from 'vitest';
import { defineGate, gate, gateLabel } from './gates.js';
import { defineModule } from './module.js';

describe('gates', () => {
  it('takes ownership of its gates', () => {
    const deleting = defineGate<{ id: string }>('deleting');
    expect(deleting.owner).toBeNull();
    defineModule({ name: 'gate_unit_a', gates: { deleting } });
    expect(deleting.owner).toBe('gate_unit_a');
    expect(gateLabel(deleting)).toBe('gate_unit_a.deleting');
  });

  it('refuses a gate that belongs to another module', () => {
    const shared = defineGate<null>('shared');
    defineModule({ name: 'gate_unit_b', gates: { shared } });
    expect(() => defineModule({ name: 'gate_unit_c', gates: { shared } })).toThrow(
      'Gate "shared" already belongs to module "gate_unit_b".',
    );
  });

  it('builds a gate listener', () => {
    const deleting = defineGate<{ id: string }>('deleting2');
    const handler = () => ({ deny: 'x' });
    expect(gate(deleting, handler)).toEqual({ kind: 'ask', ask: deleting, handler });
  });
});
