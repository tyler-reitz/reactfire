'use client';

import { useFirestoreCollection } from './adapter/firestore';
import { recipeQuery, toRecipes } from './recipes';
import type { Cuisine, Recipe } from './types';

export type FeedStatus = 'loading' | 'ready' | 'error';

/**
 * Takes over from the server-rendered list: seeds with what the server already
 * fetched, then switches to a live subscription without a loading flash.
 *
 * The key carries the cuisine, so switching filters is a different entry rather
 * than a resubscribe on the same one. That is what makes the previous filter's
 * list disappear instead of lingering.
 */
export function useRecipes(cuisine: Cuisine | 'all', initialRecipes: Recipe[]) {
  // Only the unfiltered query was rendered on the server, so only it can be
  // seeded. Seeding a filtered key with the full list would show the wrong rows.
  const { data, error } = useFirestoreCollection<Recipe[]>(`recipes:${cuisine}`, recipeQuery(cuisine), {
    map: toRecipes,
    initialData: cuisine === 'all' ? initialRecipes : undefined,
  });

  const status: FeedStatus = error ? 'error' : data ? 'ready' : 'loading';

  return {
    recipes: data ?? [],
    status,
    error: error as Error | undefined,
  };
}
