'use client';

// The shared registry for the third substrate option. Source-agnostic: it
// knows about refcounts, teardown, first-value records and subscribers, and
// nothing about Firestore or auth. Both product bindings sit on top of it.
//
// The one non-obvious decision, and the whole reason this file is separate:
// FIRST-VALUE RECORDS ARE KEYED SEPARATELY FROM SUBSCRIPTIONS and survive
// teardown. Without that, a suspending consumer under StrictMode throws a
// fresh unsettled promise after its own cleanup and the boundary never clears.
// Measured both ways; see spikes/2026-08-31-substrate-costing.md.
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type Source<T> = (onData: (value: T) => void, onError: (err: unknown) => void) => () => void;

type Entry<T> = {
  count: number;
  unsub: (() => void) | null;
  data: T | undefined;
  error: unknown;
  version: number;
  subscribers: Set<() => void>;
};

type First<T> = { promise: Promise<void>; settle: () => void; settled: boolean; error: unknown; data: T | undefined };

const entries = new Map<string, Entry<unknown>>();
const firsts = new Map<string, First<unknown>>();

export const _entries = entries;
export const _firsts = firsts;
export const _config = { latchErrors: false, leakOnUnmount: false, forgetFirstOnTeardown: false };

export function _reset() {
  entries.forEach((e) => e.unsub?.());
  entries.clear();
  firsts.clear();
}

function firstRecord<T>(key: string): First<T> {
  const existing = firsts.get(key);
  if (existing) return existing as First<T>;
  let settle!: () => void;
  const promise = new Promise<void>((res) => {
    settle = res;
  });
  const record: First<unknown> = { promise, settle, settled: false, error: undefined, data: undefined };
  firsts.set(key, record);
  return record as First<T>;
}

function settleFirst<T>(key: string, data: T | undefined, error?: unknown) {
  const record = firsts.get(key);
  if (!record) return;
  if (data !== undefined) record.data = data;
  if (record.settled) return;
  record.settled = true;
  record.error = error;
  record.settle();
}

function teardown(key: string) {
  const e = entries.get(key);
  if (!e) return;
  e.unsub?.();
  entries.delete(key);
  if (_config.forgetFirstOnTeardown) firsts.delete(key);
}

function ensure<T>(key: string, source: Source<T>): Entry<T> {
  const existing = entries.get(key);
  if (existing) return existing as Entry<T>;
  const entry: Entry<T> = {
    count: 0,
    unsub: null,
    // Seed from the retained record so a re-created entry paints the last known
    // value instead of undefined. Stale by one emission, never empty.
    data: firstRecord<T>(key).data,
    error: undefined,
    version: 0,
    subscribers: new Set(),
  };
  entries.set(key, entry as Entry<unknown>);
  entry.unsub = source(
    (value) => {
      entry.data = value;
      entry.error = undefined;
      entry.version++;
      entry.subscribers.forEach((fn) => fn());
      settleFirst(key, value);
    },
    (err) => {
      entry.error = err;
      entry.version++;
      entry.subscribers.forEach((fn) => fn());
      settleFirst<T>(key, undefined, err);
      // Drop rather than latch, so a later mount retries. Latching is #485/#742.
      if (!_config.latchErrors) teardown(key);
    },
  );
  return entry;
}

function release(key: string) {
  const e = entries.get(key);
  if (!e) return;
  if (_config.leakOnUnmount) return;
  if (--e.count <= 0) teardown(key);
}

export type Result<T> = { data: T | undefined; error: unknown };

/**
 * The one hook every binding is built from. `suspense` and non-suspense read
 * the SAME store: there is no second implementation for the suspense cohort.
 */
export function useStoreValue<T>(key: string, source: Source<T>, suspense = false): Result<T> {
  useEffect(() => {
    ensure(key, source).count++;
    return () => release(key);
    // `source` identity is deliberately not a dep: the key IS the identity.
  }, [key]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      const entry = ensure(key, source);
      entry.subscribers.add(onChange);
      return () => entry.subscribers.delete(onChange);
    },
    [key],
  );
  const getVersion = useCallback(() => entries.get(key)?.version ?? -1, [key]);
  useSyncExternalStore(subscribe, getVersion, getVersion);

  if (suspense) {
    const record = firstRecord<T>(key);
    if (!record.settled) {
      ensure(key, source);
      throw record.promise;
    }
    if (record.error) throw record.error;
  }

  const entry = entries.get(key) as Entry<T> | undefined;
  return { data: entry?.data ?? firstRecord<T>(key).data, error: entry?.error };
}
