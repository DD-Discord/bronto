import { ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { isActionRowArray } from '../src/events.js';

const row = { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: 1, custom_id: 'a', label: 'a' }] };

describe('isActionRowArray', () => {
  it('accepts arrays of action rows only', () => {
    expect(isActionRowArray([row])).toBe(true);
    expect(isActionRowArray([])).toBe(true);
    expect(isActionRowArray([{ type: ComponentType.Button }])).toBe(false);
    expect(isActionRowArray([{ type: ComponentType.ActionRow }])).toBe(false);
    expect(isActionRowArray(row)).toBe(false);
    expect(isActionRowArray(null)).toBe(false);
  });
});
