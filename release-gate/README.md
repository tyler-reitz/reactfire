# Built-artifact release gate

Verifies the packed tarball before it is published. Runs in CI as the
**Verify built artifact** job, between `build` and `publish`, against the
`reactfire.tgz` that the publish job uploads verbatim, so it checks the exact
bytes that ship.

Implemented by [`scripts/release-gate.mjs`](../scripts/release-gate.mjs).
Dependency-free by design: it needs no `npm ci`, so the CI job is fast and
cannot itself be broken by a dependency change.

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

| Check | What it catches |
| --- | --- |
| `no-cjs-in-esm` | A CJS module inlined into **any** ESM chunk, i.e. the #759 crash. Matches the bare `require` identifier, since the output is minified and the shipped 4.2.5 bundle never literally wrote `require(`. |
| `externals` | Externals getting inlined (duplicate React instance, the shim regression) or new dependencies leaking out as runtime imports. |
| `exports-map` | Any path in `exports` / `main` / `module` / `typings` missing from the tarball. |
| `types` | Any change to the emitted `.d.ts` versus the accepted baseline, i.e. the #749 class. Covers added and removed declaration files as well as changed ones. |
| `size` | Packed tarball and entry-point gzip size moving more than ±2%. |

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

## Accepting a change

`baseline/types/` and `baseline/metrics.json` are checked in. When a change to
the type surface or the bundle size is intended:

```sh
npm run gate:accept
```

Then **commit the updated baseline in the same pull request**. This is the
enforcement [#749](https://github.com/FirebaseExtended/reactfire/issues/749)
asks for: a textual diff cannot classify additive versus non-additive on its
own, so instead the gate fails on any delta and the acknowledgement is a
reviewable diff. Reviewing that diff means answering:

- Is this additive (a patch bump is fine), or non-additive (needs a minor or
  major bump plus a changelog note)?

Semantic additive/non-additive classification via api-extractor would remove the
judgement call, but it is a much larger project and deliberately not attempted
here.

## Not covered

Items 3 and 7 of [#765](https://github.com/FirebaseExtended/reactfire/issues/765)
are not implemented:

- **Both entry points load** (`import('reactfire')` and `require('reactfire')`
  in a fixture with `react` and `firebase` installed).
- **Runtime smoke render in CI** against a Next App Router and a Vite app. This
  is the strongest check and the only one that catches runtime regressions the
  static checks miss, but it is roughly a day of work on its own and adds real
  CI minutes and flake surface.

Neither is required to close the two holes that actually shipped.
