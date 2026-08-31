'use client';

import { useMutation } from '@tanstack/react-query';
import { generateRecipe } from './ai';
import { createRecipe, toggleLike } from './recipes';
import { logOut, signIn } from './session';
import type { Cuisine, RecipeDraft } from './types';

export function useSignIn() {
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => signIn(email, password),
  });
}

export function useSignOut() {
  return useMutation({ mutationFn: () => logOut() });
}

/**
 * No onSuccess, no invalidation, and that is the point. The recipes view is a
 * subscription, so the write comes back through the listener on its own.
 */
export function useToggleLike() {
  return useMutation({
    mutationFn: ({ recipeId, uid, liked }: { recipeId: string; uid: string; liked: boolean }) =>
      toggleLike(recipeId, uid, liked),
  });
}

export function useGenerateAndSaveRecipe() {
  return useMutation<RecipeDraft, Error, Cuisine>({
    mutationFn: async (cuisine: Cuisine) => {
      const generated = await generateRecipe(cuisine);
      await createRecipe(generated);
      return generated;
    },
  });
}
