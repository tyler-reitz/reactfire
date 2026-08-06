/**
 * SPIKE SCRATCH TEST, NOT FOR MERGE.
 *
 * Establishes what actually happens to the globalThis observable cache during a
 * server render, so the per-request scoping recommendation rests on observed
 * behavior rather than on reading the code.
 */
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { Observable } from 'rxjs';
import { describe, expect, it, beforeEach } from 'vitest';
import { useObservable, preloadObservable } from '../src/useObservable';
import { createObservableCache, ObservableCacheProvider, getDefaultObservableCache } from '../src/observableCache';

const globals = globalThis as any;

/**
 * FACT 0, found by getting this wrong first: the cache must be CLEARED, not REPLACED.
 * `useObservable.ts:11` binds the Map to a module-level const at import time, so
 * assigning a fresh Map to `globalThis._reactFirePreloadedObservables` leaves the
 * module writing to the original object. Swapping the global per request is therefore
 * not an available scoping strategy, and it fails silently rather than loudly.
 */
// NOTE: the prototype creates the global lazily rather than at import time, so read it
// through the accessor instead of off globalThis directly.
const cache = () => getDefaultObservableCache();
const clearCache = () => cache().clear();

/** An observable that records every subscribe/unsubscribe it receives. */
const instrumented = () => {
  const log: string[] = [];
  const obs = new Observable<string>((subscriber) => {
    log.push('subscribe');
    subscriber.next('server-value');
    return () => {
      log.push('unsubscribe');
    };
  });
  return { obs, log };
};

const Probe = ({ id, source }: { id: string; source: Observable<string> }) => {
  const { status, data } = useObservable(id, source, { suspense: false });
  return <div>{`${status}:${String(data)}`}</div>;
};

describe('SPIKE: cache behavior under server rendering', () => {
  beforeEach(() => clearCache());

  it('FACT 1: a server render populates the globalThis cache', () => {
    const { obs } = instrumented();
    expect(cache().size).toBe(0);

    renderToString(<Probe id="spike:doc:a" source={obs} />);

    expect(cache().size).toBe(1);
    expect(cache().has('spike:doc:a')).toBe(true);
  });

  it('FACT 2: the subject subscribes to the source during a server render, and never unsubscribes', () => {
    const { obs, log } = instrumented();

    renderToString(<Probe id="spike:doc:b" source={obs} />);

    // The SuspenseSubject constructor warms up by subscribing immediately.
    expect(log).toContain('subscribe');
    // Nothing on the server ever tears it down: renderToString has no effect phase,
    // so the subscription that a browser would clean up on unmount stays open.
    expect(log).not.toContain('unsubscribe');
  });

  it('FACT 3: a second "request" reuses the first requests subject and never touches its own source', () => {
    const first = instrumented();
    const second = instrumented();

    renderToString(<Probe id="spike:doc:shared" source={first.obs} />);
    renderToString(<Probe id="spike:doc:shared" source={second.obs} />);

    // Request 2 passed its own observable, and it was discarded: preloadObservable
    // returns the cached subject and ignores the source argument entirely.
    expect(first.log).toContain('subscribe');
    expect(second.log).toEqual([]);
    expect(cache().size).toBe(1);
  });

  it('FACT 4: out-of-tree preload warms the same cache a later render reads', () => {
    const preloaded = instrumented();
    const rendered = instrumented();

    preloadObservable(preloaded.obs, 'spike:doc:warm');
    renderToString(<Probe id="spike:doc:warm" source={rendered.obs} />);

    // This is the out-of-tree preload contract working as designed. It is also
    // exactly why the cache is a module global today.
    expect(preloaded.log).toContain('subscribe');
    expect(rendered.log).toEqual([]);
  });

  it('FACT 5: request 2 can observe data that only request 1 ever subscribed to', () => {
    const leaky = new Observable<string>((subscriber) => {
      subscriber.next('REQUEST-1-SECRET');
    });
    const innocent = new Observable<string>((subscriber) => {
      subscriber.next('request-2-own-data');
    });

    renderToString(<Probe id="spike:doc:leak" source={leaky} />);
    const secondHtml = renderToString(<Probe id="spike:doc:leak" source={innocent} />);

    // #779 keeps this OUT of the server-rendered HTML by reading only `config`.
    expect(secondHtml).not.toContain('REQUEST-1-SECRET');

    // But the shared subject still holds request 1's value, so anything that reads
    // the cache rather than the server snapshot sees it.
    const subject = cache().get('spike:doc:leak');
    expect(subject.immutableStatus.data).toBe('REQUEST-1-SECRET');
  });
});

/**
 * PROTOTYPE VERIFICATION: does an explicit per-request cache actually isolate?
 * This is the feasibility probe behind the size estimate, not merge-ready code.
 */
describe('SPIKE: explicit per-request cache prototype', () => {
  it('two requests with their own caches share nothing', () => {
    const req1 = instrumented();
    const req2 = instrumented();
    const cache1 = createObservableCache();
    const cache2 = createObservableCache();

    const Tree = ({ cache, source }: { cache: any; source: Observable<string> }) => (
      <ObservableCacheProvider value={cache}>
        <Probe id="spike:doc:isolated" source={source} />
      </ObservableCacheProvider>
    );

    renderToString(<Tree cache={cache1} source={req1.obs} />);
    renderToString(<Tree cache={cache2} source={req2.obs} />);

    // Both requests subscribed to their OWN source. Under the shared global cache
    // (FACT 3) the second one never got a subscription at all.
    expect(req1.log).toContain('subscribe');
    expect(req2.log).toContain('subscribe');
    expect(cache1.size).toBe(1);
    expect(cache2.size).toBe(1);
    expect(cache1.get('spike:doc:isolated')).not.toBe(cache2.get('spike:doc:isolated'));
  });

  it('MUTATION CHECK: sharing one cache between the two requests reproduces the old behavior', () => {
    const req1 = instrumented();
    const req2 = instrumented();
    const shared = createObservableCache();

    const Tree = ({ source }: { source: Observable<string> }) => (
      <ObservableCacheProvider value={shared}>
        <Probe id="spike:doc:shared-again" source={source} />
      </ObservableCacheProvider>
    );

    renderToString(<Tree source={req1.obs} />);
    renderToString(<Tree source={req2.obs} />);

    // If this ever passes with req2 subscribing, the isolation above proves nothing.
    expect(req2.log).toEqual([]);
  });

  it('no provider means the process-wide cache, so browsers are unaffected', () => {
    const { obs } = instrumented();
    clearCache();

    renderToString(<Probe id="spike:doc:default" source={obs} />);

    expect(cache().has('spike:doc:default')).toBe(true);
  });
});
