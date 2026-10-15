import { describe, expect, it } from 'vitest';
import { defineButton, defineModal, parseCustomId } from './components.js';

describe('components', () => {
  it('builds custom IDs once a module owns the component', () => {
    const button = defineButton({ name: 'copy', execute: () => undefined });
    expect(() => button.customId('1')).toThrow('not part of a module');
    button.owner = 'notes';
    expect(button.customId()).toBe('notes:copy');
    expect(button.customId('a', 'b')).toBe('notes:copy:a:b');
    expect(() => button.customId('a:b')).toThrow('must not contain ":"');
    expect(() => button.customId('x'.repeat(100))).toThrow('longer than 100');
  });

  it('parses custom IDs', () => {
    expect(parseCustomId('notes:copy:a:b')).toEqual({ module: 'notes', name: 'copy', args: ['a', 'b'] });
    expect(parseCustomId('notes:copy')).toEqual({ module: 'notes', name: 'copy', args: [] });
    expect(parseCustomId('nocolon')).toBeNull();
  });

  it('rejects invalid names', () => {
    expect(() => defineModal({ name: 'Bad:name', execute: () => undefined })).toThrow('Component name');
  });
});
