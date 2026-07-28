# Built-artifact release gate

Verifies the packed tarball before it is published. Runs in CI as the
**Verify built artifact** job, between `build` and `publish`, against the
`reactfire.tgz` that the publish job uploads verbatim, so it checks the exact
bytes that ship.

Implemented by [`scripts/release-gate.mjs`](../scripts/release-gate.mjs). It uses
only node builtins plus `tar` and `npm pack`, so the CI job needs no `npm ci` and
cannot itself be broken by a dependency change.

The `types` and `size` checks compare against the release currently on npm, which
the gate downloads with `npm pack reactfire@latest`. That is what
[#749](https://github.com/FirebaseExtended/reactfire/issues/749) specifies, and
it cannot drift: a copy checked into the repo goes stale the moment a release is
published without refreshing it, and reactfire is published by hand. The bundle
checks need no network and always run.

The two ways that download can fail are treated differently, on purpose:

- **Nothing published yet** is a legitimate skip. At bootstrap there is
  genuinely nothing to compare against.
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

| Check           | What it catches                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no-cjs-in-esm` | A CJS module inlined into **any** ESM chunk, i.e. the #759 crash. Matches the bare `require` identifier, since the output is minified and the shipped 4.2.5 bundle never literally wrote `require(`.                                 |
| `externals`     | Externals getting inlined (duplicate React instance, the shim regression) or new dependencies leaking out as runtime imports.                                                                                                        |
| `exports-map`   | Any path in `exports` / `main` / `module` / `typings` missing from the tarball.                                                                                                                                                      |
| `types`         | Any change to the emitted `.d.ts` versus the published release, i.e. the #749 class. Covers added and removed declaration files as well as changed ones. On a release commit, also fails a changed type surface cut as a patch bump. |
| `size`          | Packed tarball and entry-point gzip size moving more than ±2% from the published release.                                                                                                                                            |

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

A type or size change is not by itself a regression: adding a hook legitimately
changes the type surface. What the gate refuses is a change nobody looked at. So
when the change is intended:

```sh
npm run gate:accept
```

Then **commit `accepted.json` in the same pull request**. It records a digest of
the type surface, the measured sizes, and the published version they were taken
against:

```json
{
  "against": "4.2.6",
  "types": "sha256:...",
  "size": { "packed": 130982, "sizes": { "dist/index.js": { "bytes": 0, "gzip": 16068 } } }
}
```

That file is the acknowledgement, and it is deliberately a fingerprint rather
than a copy of every `.d.ts`. A checked-in copy would be a second type surface to
maintain; a digest is a few lines, and reviewing the pull request that changes it
means answering the question
[#749](https://github.com/FirebaseExtended/reactfire/issues/749) is really about:

- Is this additive (a patch bump is fine), or non-additive (needs a minor or
  major bump plus a changelog note)?

Two properties make it hard to misuse. The digest covers the exact surface that
was accepted, so editing the types afterwards invalidates it rather than riding
along. And it is scoped to the published version it was taken against, so it
expires on the next release instead of silently carrying forward.

At release time the gate also checks the bump itself: once `package.json` carries
a different `major.minor.patch` from the published release, a changed type
surface may not ship as a patch. During normal development the two match (the
bump is its own commit, e.g. `7f93210` "4.2.6"), so there is nothing to assert
and the rule stays quiet.

The comparison is on the numeric core, not the version string, because CI stamps
an experimental version into `package.json` before packing
(`4.2.6-exp.<sha>` while 4.2.6 is published). A string comparison read every
pull-request build as a release candidate and then, since the core matched, as a
patch bump, which would have failed the first pull request to legitimately change
the type surface. For the same reason the recorded sizes are matched within the
tolerance rather than byte-exactly: `gate:accept` runs locally, its numbers are
compared against a CI build, and the stamp alone makes those differ.

Semantic additive/non-additive classification via api-extractor would remove the
judgement call, but it is a much larger project and deliberately not attempted
here.

## Relationship to the test-suite type-check

`tsconfig.test.json` type-checks `test/` against the library's public types, and
[#750](https://github.com/FirebaseExtended/reactfire/pull/750) added guards there
naming the `ObservableStatus` regression directly. That is the better tool for
the cases it covers, and it is not duplicated here.

The two answer different questions. The test-suite check asserts that documented
consumer usage still compiles, from source, for the patterns someone wrote a test
for. This gate inventories the type surface **in the packed tarball**, whether or
not a test exercises it. Both regressions that shipped were invisible to source-
level checks: the artifact regressed while the source was fine. The remaining
four checks have no test-suite equivalent at all.

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

Item 7 of [#765](https://github.com/FirebaseExtended/reactfire/issues/765) is not
implemented:

- **Runtime smoke render in CI** against a Next App Router and a Vite app,
  rendering a data hook against the packed build.

Its original justification was being the only check that catches a runtime
regression by observing it. The entry-load test above now does that for the
#759 class, so item 7's remaining unique value is narrower: failures that appear
only in a browser or bundler context and not on a Node import. Worth re-scoping
against roughly a day of work plus permanent CI minutes and flake surface.

Neither is required to close the two holes that actually shipped.
