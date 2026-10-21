import { Events, GatewayIntentBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCommand } from '../interactions/commands.js';
import { defineButton, defineSelect } from '../interactions/components.js';
import { coreEvents, defineEvent, eventLabel, on } from './events.js';
import { defineModule } from './module.js';

describe('defineModule', () => {
  it('takes ownership of its events', () => {
    const posted = defineEvent<{ id: string }>('posted');
    defineModule({ name: 'owner_a', events: { posted } });
    expect(posted.owner).toBe('owner_a');
    expect(eventLabel(posted)).toBe('owner_a.posted');
  });

  it('rejects an event that already belongs to another module', () => {
    const shared = defineEvent('shared');
    defineModule({ name: 'owner_b', events: { shared } });
    expect(() => defineModule({ name: 'owner_c', events: { shared } })).toThrow(
      'Event "shared" already belongs to module "owner_b".',
    );
  });

  it.each(['core', 'Sticky', 'pg_x', ''])('rejects the name %j', (name) => {
    expect(() => defineModule({ name })).toThrow();
  });

  it('returns the definition as given', () => {
    const config = z.object({ webhookName: z.string() });
    const definition = defineModule({ name: 'configured', config, intents: [GatewayIntentBits.GuildMessages] });
    expect(definition.config).toBe(config);
    expect(definition.intents).toEqual([GatewayIntentBits.GuildMessages]);
  });
});

describe('on', () => {
  it('builds a Discord listener from an event name', () => {
    const handler = () => undefined;
    expect(on(Events.MessageCreate, handler)).toEqual({ kind: 'discord', event: 'messageCreate', handler });
  });

  it('builds a module listener from an event definition', () => {
    const event = defineEvent<{ n: number }>('counted');
    const handler = () => undefined;
    expect(on(event, handler)).toEqual({ kind: 'module', event, handler });
  });
});

describe('coreEvents', () => {
  it('belong to core', () => {
    expect(Object.values(coreEvents).map(eventLabel)).toEqual([
      'core.guildJoined',
      'core.guildLeft',
      'core.moduleEnabled',
      'core.moduleDisabled',
    ]);
  });
});

describe('defineModule interactions', () => {
  it('claims its components', () => {
    const button = defineButton({ name: 'copy', execute: () => undefined });
    defineModule({ name: 'notes', components: [button] });
    expect(button.owner).toBe('notes');
    expect(() => defineModule({ name: 'other', components: [button] })).toThrow(
      'Component "copy" already belongs to module "notes"',
    );
  });

  it('validates commands under their record key', () => {
    expect(() => defineModule({ name: 'cmds', commands: { 'Bad Name': defineCommand({ description: 'x', execute: () => undefined }) } })).toThrow();
  });

  it('refuses duplicate component names', () => {
    const x = defineButton({ name: 'x', execute: () => undefined });
    const y = defineButton({ name: 'x', execute: () => undefined });
    expect(() => defineModule({ name: 'dupe2', components: [x, y] })).toThrow('Button "x" is defined twice');
  });

  it('defineModule rejects two selects with one name', () => {
    const x = defineSelect({ name: 'x', execute: () => undefined });
    const y = defineSelect({ name: 'x', execute: () => undefined });
    expect(() => defineModule({ name: 'dupe3', components: [x, y] })).toThrow('Select "x" is defined twice');
    const button = defineButton({ name: 'x', execute: () => undefined });
    expect(() => defineModule({ name: 'dupe4', components: [button, defineSelect({ name: 'x', execute: () => undefined })] })).not.toThrow();
  });
});
