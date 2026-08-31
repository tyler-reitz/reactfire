'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useUser } from './adapter/auth';
import { auth, type Session } from './session';

const SessionContext = createContext<Session>({ user: null, status: 'loading' });

export function SessionProvider({ children }: { children: ReactNode }) {
  // The adapter owns the onAuthStateChanged subscription now. The context is
  // kept so consumers do not change, but it no longer holds state of its own:
  // it is a pass-through over the adapter's store.
  const { data, error } = useUser(auth);

  const session: Session = {
    user: data ?? null,
    // `data` is undefined until the first auth resolution and null once auth
    // has resolved to signed-out, and those two must not be conflated.
    status: data === undefined && !error ? 'loading' : 'ready',
  };

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
