'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { safeNext } from '@/lib/safe-next';
import { useSignIn } from '@/lib/mutations';

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const signInMutation = useSignIn();
  const error = signInMutation.error?.message;
  const pending = signInMutation.isPending;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await signInMutation.mutateAsync({ email, password });
      router.replace(safeNext(searchParams.get('next'), window.location.origin));
    } catch {
      // the mutation holds the error; nothing to do here
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <h1>Sign in</h1>

      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
          required
        />
      </label>

      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          required
        />
      </label>

      {error && <small role="alert">{error}</small>}

      <button type="submit" aria-busy={pending} disabled={pending}>
        Sign in
      </button>
    </form>
  );
}

// Next 16 requires a Suspense boundary around useSearchParams.
export default function SignInPage() {
  return (
    <Suspense fallback={<article aria-busy="true">Loading</article>}>
      <SignInForm />
    </Suspense>
  );
}
