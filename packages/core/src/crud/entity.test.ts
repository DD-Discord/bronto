import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../runtime/types.js';
import { widgetItems } from '../../test/fixtures/widgets/schema.js';
import { colorFromId, defineEntity } from './entity.js';

const created = new Date('2026-10-15T10:00:00Z');
const ctx = { guildId: 'g1' } as HandlerContext;
const row = {
  id: 'w1',
  label: 'Blue',
  count: 3,
  guildId: 'g1',
  createdAt: created,
  updatedAt: created,
  createdBy: null,
  updatedBy: null,
};

describe('colorFromId', () => {
  it('derives a stable color from the ID', () => {
    expect(colorFromId('123456789012345678')).toBe(4360151);
    expect(colorFromId('w1')).toBe(14115394);
    expect(colorFromId('w1')).toBe(colorFromId('w1'));
  });
});

describe('defineEntity', () => {
  const widgets = defineEntity({
    table: widgetItems,
    key: 'id',
    displayName: { singular: 'Widget', plural: 'Widgets' },
    formatShort: (widget) => `**${widget.label}**`,
    formatFull: async (widget, base, context) =>
      base().addFields({ name: 'Count', value: String(widget.count) }, { name: 'Guild', value: context.guildId }),
  });

  it('formats records', async () => {
    expect(widgets.keyOf(row)).toBe('w1');
    expect(widgets.formatShort(row)).toBe('**Blue**');
    expect((await widgets.formatFull(row, ctx)).toJSON()).toEqual({
      title: 'Widget',
      description: '**Blue**',
      color: 14115394,
      timestamp: created.toISOString(),
      fields: [
        { name: 'Count', value: '3' },
        { name: 'Guild', value: 'g1' },
      ],
    });
  });

  it('uses the base embed without formatFull', async () => {
    const plain = defineEntity({ table: widgetItems, key: 'id', displayName: { singular: 'Widget', plural: 'Widgets' }, formatShort: (w) => w.label });
    expect((await plain.formatFull(row, ctx)).toJSON()).toMatchObject({ title: 'Widget', description: 'Blue' });
  });

  it('refuses a key that is not a column', () => {
    expect(() =>
      defineEntity({ table: widgetItems, key: 'nope' as 'id', displayName: { singular: 'W', plural: 'Ws' }, formatShort: () => '' }),
    ).toThrow('has no column "nope"');
  });
});
