import { useSyncExternalStore } from 'react';

// Phone-width breakpoint: below this the sidebar becomes a drawer and the
// side panel becomes a full-screen sheet
const QUERY = '(max-width: 767px)';

// One MediaQueryList shared by subscribe + getSnapshot (avoids creating a new
// MQL on every render).
const mql = typeof window !== 'undefined' ? window.matchMedia(QUERY) : null;

function subscribe(callback: () => void) {
  mql?.addEventListener('change', callback);
  return () => mql?.removeEventListener('change', callback);
}

export function useIsNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mql?.matches ?? false,
    () => false,
  );
}
