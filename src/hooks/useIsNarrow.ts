import { useSyncExternalStore } from 'react';

// Phone-width breakpoint: below this the sidebar becomes a drawer and the
// side panel becomes a full-screen sheet
const QUERY = '(max-width: 767px)';

function subscribe(callback: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

export function useIsNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
