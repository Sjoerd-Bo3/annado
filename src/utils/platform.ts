// Platform detection for UI decisions: shortcut symbols, window chrome, copy.
// The Tauri webview user agent contains the host OS on every platform.
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0;

// iPad WKWebView may report a Mac-like UA; touch points disambiguate
export const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh|Mac OS X/.test(ua) && maxTouchPoints > 1);
export const isMac = /Macintosh|Mac OS X/.test(ua) && !isIOS;
export const isWindows = /Windows/.test(ua);
export const isDesktop = !isIOS && !/Android/.test(ua);

/** The conventional primary shortcut modifier: Cmd on macOS and iPad
 *  hardware keyboards, Ctrl elsewhere. */
export const PRIMARY_MOD: 'meta' | 'ctrl' = isMac || isIOS ? 'meta' : 'ctrl';

/** True when the platform's primary modifier is held. */
export function isPrimaryMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return PRIMARY_MOD === 'meta' ? e.metaKey : e.ctrlKey;
}

/** Display symbol for the primary modifier. */
const usesMacSymbols = PRIMARY_MOD === 'meta';

export const PRIMARY_MOD_SYMBOL = usesMacSymbols ? '⌘' : 'Ctrl';

export const SHIFT_SYMBOL = usesMacSymbols ? '⇧' : 'Shift';

/** Compact label for a primary-modifier shortcut: "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function primaryShortcutLabel(key: string): string {
  return usesMacSymbols ? `⌘${key}` : `Ctrl+${key}`;
}

const MOD_SYMBOLS: Record<string, string> = usesMacSymbols
  ? { meta: '⌘', shift: '⇧', ctrl: '⌃', alt: '⌥' }
  : { meta: 'Win', shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt' };

/** Convert a keybinding string like "meta+shift+k" into display keys. */
export function formatKeybinding(binding: string): string[] {
  return binding
    .toLowerCase()
    .split('+')
    .map((part) => MOD_SYMBOLS[part] ?? part.toUpperCase());
}
