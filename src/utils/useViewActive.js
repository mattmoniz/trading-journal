import { createContext, useContext } from 'react';

// Views now stay mounted (CSS display:none) across tab switches instead of
// unmounting, so a view's own setInterval-driven background polling no longer
// stops just because the user navigated away — left unchecked, several hidden
// views polling at once starves the browser's per-origin connection pool and
// can stall a newly-navigated-to view's own fetches indefinitely (observed
// directly: AllTradesView stuck on its Suspense fallback for 10+s with
// ACDView's ~10 concurrent pollers left running in the background).
//
// Usage: wrap a view's top-level JSX in <ViewActiveProvider value={isActive}>,
// then in any descendant's polling effect: read `useViewActive()` and add it
// to that effect's dependency array with an early `if (!isViewActive) return;`
// — this both stops the interval while hidden AND fires a fresh load()
// immediately on becoming visible again, rather than waiting out the interval.
const ViewActiveContext = createContext(true);

export const ViewActiveProvider = ViewActiveContext.Provider;

export function useViewActive() {
  return useContext(ViewActiveContext);
}
