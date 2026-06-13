import { describe, it, expect } from 'vitest';
import { KEYBINDING_DEFAULTS, matchesKeybinding } from './keybindings';
import { formatKeybinding, isMac, PRIMARY_MOD } from './platform';

describe('KEYBINDING_DEFAULTS', () => {
  it('uses the platform primary modifier for command shortcuts', () => {
    expect(KEYBINDING_DEFAULTS.completeTask).toBe(`${PRIMARY_MOD}+k`);
    expect(KEYBINDING_DEFAULTS.viewInbox).toBe(`${PRIMARY_MOD}+1`);
  });

  it('has no conflicting default bindings', () => {
    const values = Object.values(KEYBINDING_DEFAULTS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('matchesKeybinding', () => {
  const event = (overrides: Partial<KeyboardEvent>) =>
    ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: 'k', ...overrides }) as KeyboardEvent;

  it('matches an exact modifier combination', () => {
    expect(matchesKeybinding(event({ ctrlKey: true }), 'ctrl+k')).toBe(true);
    expect(matchesKeybinding(event({ metaKey: true }), 'meta+k')).toBe(true);
  });

  it('rejects extra or missing modifiers', () => {
    expect(matchesKeybinding(event({ ctrlKey: true, shiftKey: true }), 'ctrl+k')).toBe(false);
    expect(matchesKeybinding(event({}), 'ctrl+k')).toBe(false);
  });
});

describe('formatKeybinding', () => {
  it('renders modifiers with platform symbols', () => {
    const keys = formatKeybinding('meta+shift+k');
    if (isMac) {
      expect(keys).toEqual(['⌘', '⇧', 'K']);
    } else {
      expect(keys).toEqual(['Win', 'Shift', 'K']);
    }
  });
});
