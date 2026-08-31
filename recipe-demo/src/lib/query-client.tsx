'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * TanStack owns one-shot reads and mutations. It does NOT own subscriptions,
 * and nothing here is wired to the adapter: the two are independent state
 * containers that never touch, which is why a mutation needs no invalidation
 * to update a subscribed view.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  // Created in state, not at module scope: a module-level client would be
  // shared across requests on the server.
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
