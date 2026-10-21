import { describe, expect, it } from 'vitest';
import {
  checkCustomId,
  createCustomId,
  defineButton,
  defineModal,
  defineSelect,
  parseCustomId,
  type ComponentDefinition,
} from './components.js';
import { ComponentSigner } from './signing.js';

const signer = new ComponentSigner('s'.repeat(32));
const target = { guildId: 'g1', userId: 'u1', channelId: 'c1' };
const owned = <T extends ComponentDefinition>(component: T): T => {
  component.owner = 'notes';
  return component;
};
const button = owned(defineButton({ name: 'text', execute: () => undefined }));
const modal = owned(defineModal({ name: 'text', execute: () => undefined }));
const mine = owned(defineButton({ name: 'mine', bind: { user: true, channel: true }, execute: () => undefined }));
const brief = owned(defineModal({ name: 'brief', expiresAfterMs: 60_000, execute: () => undefined }));

const select = owned(defineSelect({ name: 'text', execute: () => undefined }));

describe('components', () => {
  it('round-trips arguments', () => {
    const id = createCustomId(signer, button, target, ['n1'], 0);
    expect(id).toMatch(/^notes:text:n1:[A-Za-z0-9_-]{11}$/);
    expect(checkCustomId(signer, button, id, target, 0)).toEqual({ ok: true, args: ['n1'] });
  });

  it('rejects a changed argument', () => {
    const id = createCustomId(signer, button, target, ['n1'], 0).replace(':n1:', ':n2:');
    expect(checkCustomId(signer, button, id, target, 0)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a button ID used as a modal of the same name', () => {
    const id = createCustomId(signer, button, target, ['n1'], 0);
    expect(checkCustomId(signer, modal, id, target, 0)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('binds every ID to its server', () => {
    const id = createCustomId(signer, button, target, [], 0);
    expect(checkCustomId(signer, button, id, { ...target, guildId: 'g2' }, 0).ok).toBe(false);
  });

  it('ignores user and channel unless the definition binds them', () => {
    const id = createCustomId(signer, button, target, [], 0);
    expect(checkCustomId(signer, button, id, { guildId: 'g1', userId: 'u2', channelId: 'c2' }, 0).ok).toBe(true);
  });

  it('binds modals to the user and bound buttons to user and channel', () => {
    const formId = createCustomId(signer, modal, target, [], 0);
    expect(checkCustomId(signer, modal, formId, { ...target, userId: 'u2' }, 0).ok).toBe(false);
    const mineId = createCustomId(signer, mine, target, [], 0);
    expect(checkCustomId(signer, mine, mineId, { ...target, userId: 'u2' }, 0).ok).toBe(false);
    expect(checkCustomId(signer, mine, mineId, { ...target, channelId: 'c2' }, 0).ok).toBe(false);
    expect(checkCustomId(signer, mine, mineId, target, 0).ok).toBe(true);
  });

  it('throws when a binding has no value', () => {
    expect(() => createCustomId(signer, modal, { ...target, userId: null }, [], 0)).toThrow('needs a user');
    expect(() => createCustomId(signer, mine, { ...target, channelId: null }, [], 0)).toThrow('needs a channel');
  });

  it('refuses components that no module owns yet', () => {
    const loose = defineButton({ name: 'loose', execute: () => undefined });
    expect(() => createCustomId(signer, loose, target, [], 0)).toThrow('not part of a module');
  });

  it('expires IDs of definitions with expiresAfterMs', () => {
    const id = createCustomId(signer, brief, target, ['x'], 1_000_000);
    expect(id.split(':')).toHaveLength(5);
    expect(checkCustomId(signer, brief, id, target, 1_000_000 + 59_000)).toEqual({ ok: true, args: ['x'] });
    expect(checkCustomId(signer, brief, id, target, 1_000_000 + 61_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('treats a forged expiry as invalid, not expired', () => {
    const parts = createCustomId(signer, brief, target, ['x'], 1_000_000).split(':');
    parts[3] = '1';
    expect(checkCustomId(signer, brief, parts.join(':'), target, 1_000_000 + 61_000)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('uses the definition, not the ID, to decide on expiry', () => {
    const plain = createCustomId(signer, modal, target, ['x'], 0);
    const expiring = owned(defineModal({ name: 'text', expiresAfterMs: 1000, execute: () => undefined }));
    expect(checkCustomId(signer, expiring, plain, target, 0)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects malformed IDs', () => {
    for (const id of ['notes:text', 'notes:text:', 'notes:text:!!!!!!!!!!!', 'garbage', '']) {
      expect(checkCustomId(signer, button, id, target, 0)).toEqual({ ok: false, reason: 'invalid' });
    }
    for (const id of ['notes:brief:x:!!:aaaaaaaaaaa', 'notes:brief:aaaaaaaaaaa']) {
      expect(checkCustomId(signer, brief, id, target, 0)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses IDs over 100 characters and arguments with ":"', () => {
    expect(() => createCustomId(signer, button, target, ['x'.repeat(90)], 0)).toThrow('longer than 100');
    expect(() => createCustomId(signer, button, target, ['a:b'], 0)).toThrow('must not contain ":"');
  });

  it('refuses a user-unbound modal and invalid expiries', () => {
    expect(() => defineModal({ name: 'm', bind: { user: false } as never, execute: () => undefined })).toThrow(
      'always bound to its user',
    );
    for (const expiresAfterMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => defineButton({ name: 'b', expiresAfterMs, execute: () => undefined })).toThrow('expiresAfterMs');
    }
  });

  it('parses custom IDs', () => {
    expect(parseCustomId('notes:copy:a:b')).toEqual({ module: 'notes', name: 'copy', rest: ['a', 'b'] });
    expect(parseCustomId('notes:copy')).toEqual({ module: 'notes', name: 'copy', rest: [] });
    expect(parseCustomId('nocolon')).toBeNull();
  });

  it('rejects invalid names', () => {
    expect(() => defineModal({ name: 'Bad:name', execute: () => undefined })).toThrow('Component name');
  });

  it('defineSelect validates names like buttons', () => {
    expect(() => defineSelect({ name: 'Bad:name', execute: () => undefined })).toThrow('Component name');
    expect(() => defineSelect({ name: 'a'.repeat(33), execute: () => undefined })).toThrow('Component name');
    expect(() => defineSelect({ name: 's', expiresAfterMs: 0, execute: () => undefined })).toThrow('expiresAfterMs');
    expect(defineSelect({ name: 'pick', execute: () => undefined })).toMatchObject({
      kind: 'select',
      defer: 'reply',
      bind: { user: false, channel: false },
    });
  });

  it('signs selects apart from buttons and modals of the same name', () => {
    const id = createCustomId(signer, select, target, ['n1'], 0);
    expect(checkCustomId(signer, select, id, target, 0)).toEqual({ ok: true, args: ['n1'] });
    expect(checkCustomId(signer, button, id, target, 0)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkCustomId(signer, modal, id, target, 0)).toEqual({ ok: false, reason: 'invalid' });
  });
});
