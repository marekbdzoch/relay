import { lazy, type ComponentType } from 'react';

const loaders: (() => Promise<unknown>)[] = [];

/** React.lazy for a named export; the chunk is also registered for idle-time prefetching. */
export function lazyNamed<M extends Record<string, unknown>, K extends keyof M>(loader: () => Promise<M>, name: K) {
  loaders.push(loader);
  return lazy(() => loader().then((m) => ({ default: m[name] as ComponentType<any> }))) as unknown as M[K];
}

/** Downloads all lazily loaded chunks when the browser is idle, so later navigation is instant. */
export function prefetchLazyChunks() {
  const run = () => {
    for (const load of loaders) void load().catch(() => {});
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}
