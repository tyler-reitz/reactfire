'use client';

// Firestore bindings on the shared registry. Collection and doc, each with the
// cache mode. The mode selects the ACQUISITION strategy only; store, key,
// return shape and teardown are identical across modes.
import {
  onSnapshot,
  getDocs,
  getDocsFromServer,
  getDoc,
  getDocFromServer,
  type Query,
  type DocumentReference,
  type QuerySnapshot,
  type DocumentSnapshot,
} from 'firebase/firestore';
import { useStoreValue, type Source, type Result } from './registry';

export type CacheMode = 'liveServer' | 'oneServer' | 'oneCache';
export type Options<T = unknown> = { cache?: CacheMode; suspense?: boolean; initialData?: T };

type Row = Record<string, unknown> & { id: string };

const rows = (snap: QuerySnapshot): Row[] => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const row = (snap: DocumentSnapshot): Row | undefined => (snap.exists() ? ({ id: snap.id, ...snap.data() } as Row) : undefined);

// One factory serves both products: the only difference is which SDK calls it
// closes over. This is the ~17 marginal lines the doc binding was priced at.
function source<S, V>(
  ref: S,
  mode: CacheMode,
  project: (snap: any) => V,
  live: (ref: S, obs: { next: (s: any) => void; error: (e: unknown) => void }) => () => void,
  once: (ref: S, fromServer: boolean) => Promise<any>,
): Source<V> {
  return (onData, onError) => {
    if (mode === 'liveServer') {
      return live(ref, { next: (snap) => onData(project(snap)), error: onError });
    }
    once(ref, mode === 'oneServer')
      .then((snap) => onData(project(snap)))
      .catch(onError);
    return () => {};
  };
}

export function useFirestoreCollection<T = Row[]>(
  key: string,
  q: Query,
  options: Options<T> & { map?: (snap: QuerySnapshot) => T } = {},
): Result<T> {
  const { cache = 'liveServer', suspense = false, initialData, map } = options;
  // Default projection is the plain row shape, which is what every caller that
  // does not care about field types wants.
  // NOTE: `map` is deliberately not a dependency of anything. The registry keys
  // on `key` alone, and a projector defined inline in a component body is a new
  // function on every render.
  const project = (map ?? (rows as unknown as (snap: QuerySnapshot) => T)) as (snap: QuerySnapshot) => T;
  return useStoreValue<T>(
    key,
    source(q, cache, project, (r, obs) => onSnapshot(r, obs), (r, fromServer) => (fromServer ? getDocsFromServer(r) : getDocs(r))),
    { suspense, initialData },
  );
}

export function useFirestoreDoc(key: string, ref: DocumentReference, options: Options<Row | undefined> = {}): Result<Row | undefined> {
  const { cache = 'liveServer', suspense = false, initialData } = options;
  return useStoreValue<Row | undefined>(
    key,
    source(ref, cache, row, (r, obs) => onSnapshot(r, obs), (r, fromServer) => (fromServer ? getDocFromServer(r) : getDoc(r))),
    { suspense, initialData },
  );
}
