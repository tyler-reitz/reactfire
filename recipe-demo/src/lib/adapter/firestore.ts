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
export type Options = { cache?: CacheMode; suspense?: boolean };

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

export function useFirestoreCollection(key: string, q: Query, options: Options = {}): Result<Row[]> {
  const { cache = 'liveServer', suspense = false } = options;
  return useStoreValue<Row[]>(
    key,
    source(q, cache, rows, (r, obs) => onSnapshot(r, obs), (r, fromServer) => (fromServer ? getDocsFromServer(r) : getDocs(r))),
    suspense,
  );
}

export function useFirestoreDoc(key: string, ref: DocumentReference, options: Options = {}): Result<Row | undefined> {
  const { cache = 'liveServer', suspense = false } = options;
  return useStoreValue<Row | undefined>(
    key,
    source(ref, cache, row, (r, obs) => onSnapshot(r, obs), (r, fromServer) => (fromServer ? getDocFromServer(r) : getDoc(r))),
    suspense,
  );
}
