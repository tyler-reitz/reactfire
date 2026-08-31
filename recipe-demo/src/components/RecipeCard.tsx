'use client';

import { useToggleLike } from '@/lib/mutations';
import { useSession } from '@/lib/session-context';
import type { Recipe } from '@/lib/types';

export function RecipeCard({ recipe }: { recipe: Recipe }) {
  const { user } = useSession();
  const liked = user ? recipe.likedBy.includes(user.uid) : false;
  const likeMutation = useToggleLike();
  const pending = likeMutation.isPending;

  function onToggleLike() {
    if (!user) return;
    // No invalidation on success: the recipes view is a subscription and the
    // write arrives back through the listener.
    likeMutation.mutate({ recipeId: recipe.id, uid: user.uid, liked });
  }

  return (
    <article>
      <header>
        <strong>{recipe.title}</strong>
        <br />
        <small>{recipe.cuisine}</small>
      </header>

      <details>
        <summary>Ingredients and steps</summary>
        <ul>
          {recipe.ingredients.map((ingredient) => (
            <li key={ingredient}>{ingredient}</li>
          ))}
        </ul>
        <ol>
          {recipe.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </details>

      <footer>
        <button
          className={liked ? undefined : 'secondary'}
          onClick={onToggleLike}
          disabled={!user || pending}
          aria-busy={pending}
        >
          {liked ? 'Liked' : 'Like'} ({recipe.likedBy.length})
        </button>
        {!user && <small> Sign in to like recipes.</small>}
      </footer>
    </article>
  );
}
