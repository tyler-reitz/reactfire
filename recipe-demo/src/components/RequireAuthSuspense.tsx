'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSigninCheck } from '@/lib/adapter/auth';
import { auth } from '@/lib/session';

/**
 * The suspense half of the demo. The homepage feed and the session nav read the
 * same adapter store without suspending; this route suspends on it. One
 * binding, two cohorts, which is the whole claim.
 *
 * There is no 'loading' branch here on purpose: under suspense the hook does
 * not return until auth has resolved, so the boundary owns that state.
 */
export function RequireAuthSuspense({ children }: { children: ReactNode }) {
  const { data } = useSigninCheck(auth, { suspense: true });
  const router = useRouter();
  const pathname = usePathname();
  const signedIn = data?.signedIn ?? false;

  useEffect(() => {
    if (!signedIn) {
      router.replace(`/signin?next=${encodeURIComponent(pathname)}`);
    }
  }, [signedIn, router, pathname]);

  if (!signedIn) {
    return null;
  }

  return <>{children}</>;
}
