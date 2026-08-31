'use client';

// Auth binding on the shared registry. ONE implementation, serving suspense
// and non-suspense alike.
//
// This is the file the whole costing turns on. On the TanStack substrate the
// 61-line `useSyncExternalStore` auth binding could not suspend at all
// (useSyncExternalStore cannot), so a SECOND auth binding had to be written on
// TanStack for the suspense cohort, and the package would have to carry both.
// Here the registry holds the promise, so one binding covers both.
//
// #514 IMMUNITY IS A DESIGN PROPERTY, NOT A BETTER KEY. The cache key is the
// TOKEN, which does not depend on the validator; the validator runs on the
// caller's own render and nothing about it is ever cached or shared. A key
// derived from the validator is #514, and `fn.name` is "" for the inline arrow
// that is the realistic call site.
import { onIdTokenChanged, type Auth, type User, type IdTokenResult } from 'firebase/auth';
import { useStoreValue, type Source, type Result } from './registry';

export type AuthOptions = { suspense?: boolean };

type TokenState = { user: User | null; token: IdTokenResult | null };

const userSource = (auth: Auth): Source<User | null> => (onData, onError) =>
  onIdTokenChanged(auth, (u) => onData(u), onError);

const tokenSource = (auth: Auth): Source<TokenState> => (onData, onError) =>
  onIdTokenChanged(
    auth,
    (u) => {
      if (!u) return onData({ user: null, token: null });
      u.getIdTokenResult().then((token) => onData({ user: u, token })).catch(onError);
    },
    onError,
  );

export function useUser(auth: Auth, options: AuthOptions = {}): Result<User | null> {
  return useStoreValue<User | null>(`auth:user:${auth.app.name}`, userSource(auth), options.suspense ?? false);
}

export type SigninCheckResult = { signedIn: boolean; user: User | null; hasRequiredClaims: boolean };

export function useSigninCheck(
  auth: Auth,
  options: AuthOptions & {
    requiredClaims?: Record<string, unknown>;
    validateCustomClaims?: (claims: IdTokenResult['claims']) => boolean;
  } = {},
): Result<SigninCheckResult> {
  const { data, error } = useStoreValue<TokenState>(`auth:token:${auth.app.name}`, tokenSource(auth), options.suspense ?? false);
  if (!data) return { data: undefined, error };

  const { user, token } = data;
  // Run on the caller's render. Two components with different validators reach
  // different answers from the same shared token, which is exactly what #514
  // gets wrong.
  let hasRequiredClaims = true;
  if (token) {
    if (options.validateCustomClaims) hasRequiredClaims = options.validateCustomClaims(token.claims);
    else if (options.requiredClaims) {
      hasRequiredClaims = Object.entries(options.requiredClaims).every(([k, v]) => token.claims[k] === v);
    }
  } else {
    hasRequiredClaims = false;
  }
  return { data: { signedIn: !!user, user, hasRequiredClaims }, error };
}
