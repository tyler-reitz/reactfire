# Built-artifact release gate

Verifies the packed tarball before it is published. Runs in CI as the
**Verify built artifact** job, between `build` and `publish`, against the
`reactfire.tgz` that the publish job uploads verbatim, so it checks the exact
bytes that ship.

Implemented by [`scripts/release-gate.mjs`](../scripts/release-gate.mjs). It uses
only node builtins plus `tar` and `npm pack`, so the CI job needs no `npm ci` and
cannot itself be broken by a dependency change.

This covers the **runtime** half of the release checks: does the built artifact
still work. The **type** half, diffing the emitted `.d.ts` against the published
release and applying semver to it, is
[#749](https://github.com/FirebaseExtended/reactfire/issues/749) and is handled
separately. It needs `typescript`, and keeping it out of this file is what lets
the gate stay dependency-free.

The `size` check compares against the release currently on npm, which the gate
downloads with `npm pack`. That cannot drift: a copy checked into the repo goes
stale the moment a release is published without refreshing it, and reactfire is
published by hand. The bundle checks need no network and always run.

### Which release it compares against

The newest published release **sharing the candidate's major** (`reactfire@^4`
for a 4.x build), not the `latest` dist-tag.

Using `latest` breaks the entire v4 line the moment 5.0.0 takes that tag. A 4.2.7
compared against 5.0.0 is a different version but not an increase, because a
lower major can never register as a bump, so maintenance releases, minors, and
even the stamped canary builds CI produces would all be measured against an
artifact from a different major line. That is every v4 pull request, not just
release cuts.

Derived from the candidate rather than read from a per-branch dist-tag on
purpose: a `v4` tag would have to be maintained correctly on every publish, and
reactfire is published by hand, so it would drift. Same reasoning that ruled out
a committed baseline.

When the candidate's major has nothing published yet (the `v5` line before 5.0.0
ships), the gate falls back to `latest` and says so. A v5 build measured against
the v4 artifact is a weak comparison, but it is better than skipping the checks
outright, and a genuine size regression still shows up against either baseline.

The ways that download can fail are treated differently, on purpose:

- **Nothing published yet** is a legitimate skip. At bootstrap there is
  genuinely nothing to compare against.
- **Nothing matching this major** is the new-major case above, and falls back
  rather than skipping. npm reports it as `ETARGET`, distinct from the `E404` it
  returns for a package that does not exist at all.
- **The fetch failed** is a failure, after three attempts with backoff. Skipping
  would be indistinguishable from passing in the check's status, so a registry
  blip would quietly produce an ungated release. Re-run the job instead; if npm
  is down it clears on its own. A wedged pull request is a better outcome than a
  gate that has silently stopped gating.

## Why

Two dist-level regressions shipped as patch releases with nothing in the release
flow comparing the built artifact:

- **4.2.4** changed `ObservableStatus<T>` from a flat interface into a
  discriminated union. Type-only, but it broke strict-TS consumers on a patch
  bump ([#749](https://github.com/FirebaseExtended/reactfire/issues/749)).
- **4.2.4 / 4.2.5** bundled the CJS `use-sync-external-store/shim` into the ESM
  output, producing a dynamic `require()` that threw in any browser bundle
  ([#759](https://github.com/FirebaseExtended/reactfire/issues/759), fixed by
  [#760](https://github.com/FirebaseExtended/reactfire/pull/760)).

In both cases the source was fine and only the emitted artifact regressed. Both
are caught by this gate (verified by running it against the published 4.2.4 and
4.2.5 tarballs).

## Checks

| Check           | What it catches                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-cjs-in-esm` | A CJS module inlined into **any** ESM chunk, i.e. the #759 crash. Matches the bare `require` identifier, since the output is minified and the shipped 4.2.5 bundle never literally wrote `require(`. |
| `externals`     | Externals getting inlined (duplicate React instance, the shim regression) or new dependencies leaking out as runtime imports.                                                                        |
| `exports-map`   | Any path in `exports` / `main` / `module` / `typings` missing from the tarball.                                                                                                                      |
| `size`          | Packed tarball and entry-point gzip size moving more than ±2% from the published release.                                                                                                            |

### What `size` is and is not

It is a coarse guard against gross packaging changes, for example `files`
sweeping in something it should not. **It is not a reliable inlining detector**,
and the table above should not be read as claiming otherwise.

Measured against the real artifacts, the #759 shim inlining moved the ESM entry
only **+3.1%** gzip (16815 to 17330 B) and the packed tarball **+0.3%**. An
earlier draft of this gate used a ±10% band, which would have missed that
entirely. The tolerance is now ±2%: tight enough to see a #759-sized change,
loose enough to clear the version stamp CI writes into the bundle (measured at
+0.5% on the tarball, +0.2% on the entries).

`no-cjs-in-esm` and `externals` are what actually catch inlining. Treat `size`
as a backstop.

## Tests

The detection logic is pinned by `test/release-gate.test.mjs`:

```sh
npm run test:gate      # no emulators needed
```

A gate that silently stops gating is worse than no gate, so the checks are
covered by tests rather than by having been verified by hand once. The fixtures
are byte-faithful to the shapes that actually shipped, including the 4.2.5
`require` shim.

## Running it

```sh
npm run build          # or: npx tsc && npx vite build
npm run gate           # packs and verifies
npm run gate -- path/to/reactfire.tgz   # verify a specific tarball
```

The local pack stages from `git ls-files` plus `dist/`, not the working tree.
`files` includes `src`, so packing the working tree directly would sweep in any
untracked scratch work under `src/`. Staging keeps a local run comparable with
what CI packs from a clean checkout.

## Accepting a size change

Size is the one check with no way to tell an intended change from a regression:
there is no principled basis for deciding that a bundle growing 4% was meant. So
when it was:

```sh
npx tsc && npx vite build   # accept measures the current build
npm run gate:accept
```

Then **commit `accepted.json` in the same pull request**:

```json
{
  "against": "4.2.6",
  "size": { "packed": 130982, "sizes": { "dist/index.js": { "bytes": 0, "gzip": 16068 } } }
}
```

It is scoped to the published version it was taken against, so a new release
expires it instead of letting it silently carry forward.

The recorded sizes are matched within the tolerance rather than byte-exactly.
`gate:accept` runs locally, its numbers get compared against a CI build, and the
two are never byte-identical: CI stamps an experimental version into the bundle
before packing (`4.2.6-exp.<sha>`), which measured about +0.5% on the tarball.
Exact matching would mean no acknowledgment ever applied in CI, so an intended
size change could not be landed at all.

## Relationship to the test-suite type-check

`tsconfig.test.json` type-checks `test/` against the library's public types, and
[#750](https://github.com/FirebaseExtended/reactfire/pull/750) added guards there
naming the `ObservableStatus` regression directly. That covers the type side from
source, and nothing here duplicates it.

Neither reaches what these checks do. Both regressions that shipped were
invisible to source-level checking, because the source was fine and only the
emitted artifact regressed: a source type-check cannot see that the ESM bundle
acquired a `require` call, and the test suite never loads the packed tarball at
all. These four checks have no test-suite equivalent.

## Entry-point load test

Item 3 of [#765](https://github.com/FirebaseExtended/reactfire/issues/765), in
[`scripts/entry-load.mjs`](../scripts/entry-load.mjs) and the **Verify package
loads** CI job:

```sh
npm run build
npm run loads -- reactfire.tgz            # both React majors
npm run loads -- reactfire.tgz --react 19 # one, and --keep to inspect the fixture
```

It installs the packed tarball into a throwaway project with real `react` and
`firebase`, then loads both entry points and checks that known exports are
actually present. Run against React 18 and 19, matching the type-check matrix.

**It is a separate script and a separate CI job on purpose.** It needs a real
dependency tree, and keeping it out of `release-gate.mjs` is what lets the gate
stay dependency-free.

It catches the #759 class by observing the failure rather than by pattern-
matching the artifact. Verified against the published tarballs:

| Version | `import('reactfire')`           | `require('reactfire')` |
| ------- | ------------------------------- | ---------------------- |
| 4.2.4   | throws the `require` shim error | loads                  |
| 4.2.5   | throws the `require` shim error | loads                  |
| 4.2.6   | loads                           | loads                  |

Note that only the ESM entry breaks, so a check that loaded one entry point
would have missed it. `exports-map` cannot see this at all: every file it looks
for is present in 4.2.5, the package just does not run.

## Not covered

**Item 6 of [#765](https://github.com/FirebaseExtended/reactfire/issues/765),**
the published `.d.ts` diff, which that issue notes is tracked in
[#749](https://github.com/FirebaseExtended/reactfire/issues/749). It lands
separately, with the check that classifies a type change as additive or
breaking, so that the diff and its interpretation arrive together.

**Item 7 of [#765](https://github.com/FirebaseExtended/reactfire/issues/765),**
a runtime smoke render in CI against a Next App Router and a Vite app, rendering
a data hook against the packed build.

Item 7's original justification was being the only check that catches a runtime
regression by observing it. The entry-load test above now does that for the #759
class, so its remaining unique value is narrower: failures that appear only in a
browser or bundler context and not on a Node import. Worth re-scoping against
roughly a day of work plus permanent CI minutes and flake surface.

Neither is required to close the runtime hole that actually shipped.
