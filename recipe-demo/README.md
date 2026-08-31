# recipe-demo, three-lane arm

The same app as the `recipe-demo` and `recipe-demo-framework` branches, with the
data layer split three ways.

| Lane | Owns | Where |
| --- | --- | --- |
| Firebase JS SDK, direct | Sync factories: `initializeApp`, `getFirestore`, `getAuth`, `getAI` | `src/lib/firebase.ts`, `src/lib/session.ts` |
| TanStack Query | Async one-shots and mutations: sign in, sign out, toggle like, generate and save | `src/lib/mutations.ts` |
| The subscription adapter | Anything returning `Unsubscribe`: the live recipes query, `onAuthStateChanged` | `src/lib/adapter/` |

**The rule for which lane a call belongs in is its return type.** A value means
call it directly. A `Promise` means TanStack. An `Unsubscribe` means the adapter.

**The adapter and TanStack never touch.** They are independent state containers,
which is why no mutation in this app invalidates anything: a write to a
subscribed view comes back through the listener on its own.

The adapter also has `oneServer` and `oneCache` cache modes. Those exist for
switching a **live** query to one-shot without changing hooks, not for wrapping
calls that were never subscriptions. Anything that was never a subscription goes
to TanStack.

`src/lib/adapter/` is vendored, not a dependency. Nothing is published.

## Running it

Emulators, from the repository root:

```
npx firebase emulators:start --only auth,firestore --project=rxfire-525a3
```

Then, with `.env.local` carrying `NEXT_PUBLIC_USE_EMULATORS=true` and
`NEXT_PUBLIC_FIREBASE_PROJECT_ID=rxfire-525a3`:

```
node --env-file=.env.local scripts/seed.mjs
npx next build && npx next start
```

`npm run seed` cannot pass the env file: npm appends the flag after the script
path, where node treats it as a script argument. Firestore is on port 8085.

⚠️ **The suspense boundary check only reproduces under `npx next dev`**, because
production React does not double-invoke effects.

## Not covered

RTDB and Storage, so "not Firestore-specific" is unproven here. AI Logic
streaming and chat sessions, which are the two shapes nothing supplies and are
deferred to a second pass. Any performance or bundle-size claim.

Every Firestore read in this app is public, so the sign-out-then-sign-in
poisoning path (#485, #790) cannot be exercised here. See the findings doc.
