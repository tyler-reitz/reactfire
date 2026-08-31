'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Suspense } from 'react';
import { RequireAuthSuspense } from '@/components/RequireAuthSuspense';
import { useGenerateAndSaveRecipe } from '@/lib/mutations';
import { CUISINES, type Cuisine } from '@/lib/types';

function CreateRecipe() {
  const [cuisine, setCuisine] = useState<Cuisine>(CUISINES[0]);
  const generateMutation = useGenerateAndSaveRecipe();
  const draft = generateMutation.data;
  // Surfaced verbatim on purpose: when AI Logic is not enabled, or the billing
  // account has lapsed, the raw message is the whole diagnosis.
  const error = generateMutation.error?.message;
  const pending = generateMutation.isPending;

  function onGenerate() {
    generateMutation.mutate(cuisine);
  }

  return (
    <>
      <h1>Create a recipe</h1>

      <label>
        Cuisine
        <select value={cuisine} onChange={(e) => setCuisine(e.target.value as Cuisine)}>
          {CUISINES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <button onClick={onGenerate} aria-busy={pending} disabled={pending}>
        Generate a recipe
      </button>

      {error && (
        <article aria-invalid="true">
          <strong>Generation failed</strong>
          <p>{error}</p>
        </article>
      )}

      {draft && (
        <article>
          <strong>{draft.title}</strong> was added. <Link href="/">See it on the homepage.</Link>
        </article>
      )}
    </>
  );
}

export default function CreateRecipePage() {
  return (
    <Suspense fallback={<article aria-busy="true">Checking your session</article>}>
      <RequireAuthSuspense>
        <CreateRecipe />
      </RequireAuthSuspense>
    </Suspense>
  );
}
