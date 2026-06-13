// Platform detection for UI decisions: shortcut symbols, window chrome, copy.
// The Tauri webview user agent contains the host OS on every platform.
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

export const isMac = /Macintosh|Mac OS X/.test(ua);
export const isWindows = /Windows/.test(ua);

/** The conventional primary shortcut modifier: Cmd on macOS, Ctrl elsewhere. */
export const PRIMARY_MOD: 'meta' | 'ctrl' = isMac ? 'meta' : 'ctrl';

/** True when the platform's primary modifier is held. */
export function isPrimaryMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** Display symbol for the primary modifier. */
export const PRIMARY_MOD_SYMBOL = isMac ? '⌘' : 'Ctrl';

export const SHIFT_SYMBOL = isMac ? '⇧' : 'Shift';

/** Compact label for a primary-modifier shortcut: "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function primaryShortcutLabel(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

const MOD_SYMBOLS: Record<string, string> = isMac
  ? { meta: '⌘', shift: '⇧', ctrl: '⌃', alt: '⌥' }
  : { meta: 'Win', shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt' };

/** Convert a keybinding string like "meta+shift+k" into display keys. */
export function formatKeybinding(binding: string): string[] {
  return binding
    .toLowerCase()
    .split('+')
    .map((part) => MOD_SYMBOLS[part] ?? part.toUpperCase());
}
