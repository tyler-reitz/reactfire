import * as React from 'react';
import type { SuspenseSubject } from './SuspenseSubject.js';
import type { ReactFireGlobals } from './index.js';

/**
 * SPIKE PROTOTYPE, NOT A MERGE CANDIDATE.
 *
 * The store of live observables, keyed by observableId. Today this is a single Map
 * on globalThis, which means every concurrent SSR request shares one of these.
 */
export type ObservableCache = Map<string, SuspenseSubject<any>>;

/**
 * Create an isolated cache. On a server, call this once per request and pass it to
 * `FirebaseAppProvider` so nothing is shared between requests.
 */
export function createObservableCache(): ObservableCache {
  return new Map();
}

/**
 * The process-wide cache. Still the default, so browser behavior is unchanged and
 * the out-of-tree preload functions keep working with no argument.
 */
export function getDefaultObservableCache(): ObservableCache {
  const globals = globalThis as any as ReactFireGlobals;

  if (!globals._reactFirePreloadedObservables) {
    globals._reactFirePreloadedObservables = new Map();
  }

  // Read through the global on every call rather than binding it to a module-level
  // const. The old code bound it once at import, so replacing the global silently
  // had no effect on where entries actually went.
  return globals._reactFirePreloadedObservables;
}

const ObservableCacheContext = React.createContext<ObservableCache | undefined>(undefined);

export const ObservableCacheProvider = ObservableCacheContext.Provider;

/**
 * The cache the surrounding provider supplied, or the process-wide one if a caller
 * never opted in.
 */
export function useObservableCache(): ObservableCache {
  const cacheFromContext = React.useContext(ObservableCacheContext);

  return cacheFromContext ?? getDefaultObservableCache();
}
