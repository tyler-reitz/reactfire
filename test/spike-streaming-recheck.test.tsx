/**
 * SPIKE SCRATCH TEST, NOT FOR MERGE.
 *
 * Re-runs the cache-scoping findings under `renderToPipeableStream` rather than
 * `renderToString`. Streaming is what the Next.js App Router actually uses, and
 * Armando's #779 review showed it surfaces failures `renderToString` hides (an empty
 * shell plus `onShellError`, where `renderToString` merely throws).
 *
 * The point is to find out whether any spike FACT changes shape under streaming,
 * because the V5 back-plan was rewritten on those FACTs.
 */
import * as React from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { Writable } from 'node:stream';
import { Observable } from 'rxjs';
import { describe, expect, it, beforeEach } from 'vitest';
import { useObservable, preloadObservable } from '../src/useObservable';
import { createObservableCache, ObservableCacheProvider, getDefaultObservableCache } from '../src/observableCache';

const cache = () => getDefaultObservableCache();
const clearCache = () => cache().clear();

type StreamResult = { html: string; shellError?: unknown; errors: unknown[] };

/** Render through the streaming renderer and collect everything React reports. */
const renderStream = (element: React.ReactElement): Promise<StreamResult> =>
  new Promise((resolve) => {
    const chunks: string[] = [];
    const errors: unknown[] = [];
    let settled = false;

    const writable = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
      final(cb) {
        cb();
        if (!settled) {
          settled = true;
          resolve({ html: chunks.join(''), errors });
        }
      },
    });

    const { pipe } = renderToPipeableStream(element, {
      onAllReady() {
        pipe(writable);
      },
      onShellError(e) {
        if (!settled) {
          settled = true;
          resolve({ html: chunks.join(''), shellError: e, errors });
        }
      },
      onError(e) {
        errors.push(e);
      },
    });
  });

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

describe('SPIKE RE-CHECK under renderToPipeableStream', () => {
  beforeEach(() => clearCache());

  it('sanity: the harness streams a normal render with no errors', async () => {
    const { obs } = instrumented();

    const result = await renderStream(<Probe id="stream:sanity" source={obs} />);

    expect(result.shellError).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.html).toContain('loading:undefined');
  });

  it('FACT 1 holds: a streamed server render populates the globalThis cache', async () => {
    const { obs } = instrumented();
    expect(cache().size).toBe(0);

    await renderStream(<Probe id="stream:doc:a" source={obs} />);

    expect(cache().size).toBe(1);
  });

  it('FACT 2 holds: subscribes during the stream and never unsubscribes', async () => {
    const { obs, log } = instrumented();

    await renderStream(<Probe id="stream:doc:b" source={obs} />);

    expect(log).toContain('subscribe');
    expect(log).not.toContain('unsubscribe');
  });

  it('FACT 3 holds: a second streamed request reuses the first requests subject', async () => {
    const first = instrumented();
    const second = instrumented();

    await renderStream(<Probe id="stream:doc:shared" source={first.obs} />);
    await renderStream(<Probe id="stream:doc:shared" source={second.obs} />);

    expect(first.log).toContain('subscribe');
    expect(second.log).toEqual([]);
    expect(cache().size).toBe(1);
  });

  it('FACT 4 holds: out-of-tree preload warms the cache a streamed render reads', async () => {
    const preloaded = instrumented();
    const rendered = instrumented();

    preloadObservable(preloaded.obs, 'stream:doc:warm');
    await renderStream(<Probe id="stream:doc:warm" source={rendered.obs} />);

    expect(preloaded.log).toContain('subscribe');
    expect(rendered.log).toEqual([]);
  });

  it('FACT 5 holds: the leak stays out of streamed markup but lives in the cache', async () => {
    const leaky = new Observable<string>((subscriber) => subscriber.next('REQUEST-1-SECRET'));
    const innocent = new Observable<string>((subscriber) => subscriber.next('request-2-own-data'));

    await renderStream(<Probe id="stream:doc:leak" source={leaky} />);
    const second = await renderStream(<Probe id="stream:doc:leak" source={innocent} />);

    expect(second.html).not.toContain('REQUEST-1-SECRET');
    expect(cache().get('stream:doc:leak').immutableStatus.data).toBe('REQUEST-1-SECRET');
  });

  it('the per-request cache prototype still isolates under streaming', async () => {
    const req1 = instrumented();
    const req2 = instrumented();
    const cache1 = createObservableCache();
    const cache2 = createObservableCache();

    const Tree = ({ c, source }: { c: any; source: Observable<string> }) => (
      <ObservableCacheProvider value={c}>
        <Probe id="stream:doc:isolated" source={source} />
      </ObservableCacheProvider>
    );

    await renderStream(<Tree c={cache1} source={req1.obs} />);
    await renderStream(<Tree c={cache2} source={req2.obs} />);

    expect(req1.log).toContain('subscribe');
    expect(req2.log).toContain('subscribe');
    expect(cache1.get('stream:doc:isolated')).not.toBe(cache2.get('stream:doc:isolated'));
  });

  // Distinguishes "errored" from "still waiting", which a plain await cannot.
  const withDeadline = <T,>(p: Promise<T>, ms: number): Promise<T | 'TIMED_OUT'> =>
    Promise.race([p, new Promise<'TIMED_OUT'>((r) => setTimeout(() => r('TIMED_OUT'), ms))]);

  it('NEW FINDING: suspense + a cold cache HANGS the stream, it does not error', async () => {
    // Under renderToString this throws "A component suspended while responding to
    // synchronous input". Under streaming, suspending is legitimate: React holds the
    // stream open waiting for the thrown promise. reactfire's `firstEmission` resolves
    // only on a first emission, so an observable that never emits never completes the
    // response. That is a hung request, not a crash, and it is the App Router shape.
    const never = new Observable<string>(() => {});

    const SuspenseProbe = () => {
      const { status } = useObservable('stream:suspense:cold', never, { suspense: true });
      return <div>{status}</div>;
    };

    const outcome = await withDeadline(
      renderStream(
        <React.Suspense fallback={<div>fallback</div>}>
          <SuspenseProbe />
        </React.Suspense>
      ),
      2000
    );

    expect(outcome).toBe('TIMED_OUT');
  });

  it('NEW FINDING: suspense + streaming waits for the data, then renders the placeholder anyway', async () => {
    // I expected this to render the data. It does not, and that is the finding.
    //
    // The stream DOES complete, so streaming has no synchronous-input restriction: the
    // component suspends, React holds the boundary open, the observable emits at 20ms,
    // the thrown `firstEmission` resolves and React retries. But the retry is still a
    // SERVER render, so `useSyncExternalStore` reads `getServerSnapshot`, which #779
    // deliberately refuses to read the cache from. So the value that just arrived is
    // discarded and the boundary resolves to `loading:undefined`.
    //
    // Net effect in suspense mode under streaming: reactfire holds the response open
    // waiting for data it will then decline to render. The caller pays the latency and
    // gets the placeholder anyway. #779 is still right (reading that cache is the
    // cross-request leak), which makes this an argument that per-request scoping is what
    // unlocks server-rendered data, not a defect in #779.
    const emitsSoon = new Observable<string>((subscriber) => {
      setTimeout(() => subscriber.next('streamed-value'), 20);
    });

    const SuspenseProbe = () => {
      const { status, data } = useObservable('stream:suspense:warm', emitsSoon, { suspense: true });
      return <div>{`${status}:${String(data)}`}</div>;
    };

    const outcome = await withDeadline(
      renderStream(
        <React.Suspense fallback={<div>fallback</div>}>
          <SuspenseProbe />
        </React.Suspense>
      ),
      3000
    );

    expect(outcome).not.toBe('TIMED_OUT');
    const result = outcome as StreamResult;
    expect(result.shellError).toBeUndefined();

    // The suspend resolved: the boundary completed rather than falling back.
    expect(result.html).toContain('<!--$-->');
    // ...and then rendered the placeholder anyway.
    expect(result.html).toContain('loading:undefined');
    expect(result.html).not.toContain('streamed-value');
  });
});
