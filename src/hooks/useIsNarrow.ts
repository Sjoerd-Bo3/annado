import { useSyncExternalStore } from 'react';

// Phone-width breakpoint: below this the sidebar becomes a drawer and the
// side panel becomes a full-screen sheet
const QUERY = '(max-width: 767px)';

// One MediaQueryList shared by subscribe + getSnapshot (avoids creating a new
// MQL on every render).
const mql = typeof window !== 'undefined' ? window.matchMedia(QUERY) : null;

// A host may force the narrow/mobile layout regardless of viewport width — e.g.
// the Obsidian plugin on a phone, where `Platform.isPhone` is the source of
// truth and the leaf can be wider than the width breakpoint. This is a
// host-agnostic seam: `src/` never imports `obsidian`; the plugin calls
// `setForcedNarrow(Platform.isPhone)` at startup. Defaults to off, so the Tauri
// and web builds keep their pure width-based behaviour.
let forcedNarrow = false;
const listeners = new Set<() => void>();

/**
 * Force (or clear) the narrow/mobile layout. A host that knows it is on a phone
 * — without relying on the viewport width — calls this once at startup.
 */
export function setForcedNarrow(value: boolean): void {
  if (forcedNarrow === value) return;
  forcedNarrow = value;
  for (const cb of listeners) cb();
}

function subscribe(callback: () => void) {
  mql?.addEventListener('change', callback);
  listeners.add(callback);
  return () => {
    mql?.removeEventListener('change', callback);
    listeners.delete(callback);
  };
}

function getSnapshot(): boolean {
  return forcedNarrow || (mql?.matches ?? false);
}

export function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => forcedNarrow);
}
