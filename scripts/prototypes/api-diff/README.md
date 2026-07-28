# API differ (PROTOTYPE, not wired into anything)

Answers the question [#749](https://github.com/FirebaseExtended/reactfire/issues/749)
actually asks and the release gate currently hands to a human: **is a `.d.ts`
change additive or breaking?**

Nothing here runs in CI. It is committed so the design work is not lost, and so
the findings below are attached to the code that produced them.

## Approach

Let `tsc` adjudicate assignability instead of hand-rolling subtyping rules.

For every symbol exported by both versions, emit two probe lines asserting
assignability in each direction, compile, and read the errors:

```ts
const __t_o2n_Foo = <T>(v: O.Foo<T>): N.Foo<T> => v; // old assignable to new?
const __t_n2o_Foo = <T>(v: N.Foo<T>): O.Foo<T> => v; // new assignable to old?
```

Roughly 3.4s for the whole package.

## Running it

```sh
mkdir -p /tmp/apidiff/old /tmp/apidiff/new
npm pack reactfire@4.2.3 --pack-destination /tmp/apidiff
npm pack reactfire@4.2.4 --pack-destination /tmp/apidiff
tar -xzf /tmp/apidiff/reactfire-4.2.3.tgz -C /tmp/apidiff/old
tar -xzf /tmp/apidiff/reactfire-4.2.4.tgz -C /tmp/apidiff/new

node scripts/prototypes/api-diff/strip-private.mjs /tmp/apidiff/old/package/dist
node scripts/prototypes/api-diff/strip-private.mjs /tmp/apidiff/new/package/dist
node scripts/prototypes/api-diff/api-diff.mjs --work /tmp/apidiff
```

`--old` and `--new` override the two `dist` directories individually. A symlink
or copy of `node_modules` must be reachable from the work directory so the
declarations' own imports (`react`, `rxjs`, `firebase/*`) resolve.

## Validation

Correct on every real version pair, including independently concluding that
4.2.6 is still breaking relative to 4.2.3 _and_ that the reason is exactly the
two hooks changed by #733, without being told any of that.

| Pair          | Verdict   | Root causes                                         |
| ------------- | --------- | --------------------------------------------------- |
| 4.2.6 → 4.2.6 | NO CHANGE | 0 (the false-positive control)                      |
| 4.2.5 → 4.2.6 | NO CHANGE | 0 (build-config fix only)                           |
| 4.2.3 → 4.2.4 | BREAKING  | 1: `ObservableStatus`, from 39 raw failures         |
| 4.2.4 → 4.2.5 | BREAKING  | 1: `ObservableStatus`, the revert                   |
| 4.2.3 → 4.2.6 | BREAKING  | 2: `useFirestoreDocData`, `useFirestoreDocDataOnce` |

Also checked against synthetic fixtures: constrained generic unchanged,
constrained generic broken, optional property added, export removed, mutually
recursive types, simple incompatible change.

## Four things that are not obvious

Each was found by a control, not by reading the code.

**1. Classes with `private` members are never assignable across two copies.**
TypeScript types them nominally, so `SuspenseSubject` made 4.2.6 compare as
BREAKING _against itself_. `strip-private.mjs` removes `private`/`protected`
members first; they are emitted for layout and are not part of the consumer
contract. Any naive two-copy differ has this flaw. **Comparing a version to
itself is the cheapest possible control and belongs in the test suite
permanently.**

**2. Attribution has to walk non-exported types.** `useInitAuth` is declared as
`InitSdkHook<Auth>`, and `InitSdkHook` is a non-exported alias returning
`ObservableStatus<Sdk>`. Following only exported names made nine symbols look
like independent roots when their declarations were byte-identical across
versions.

**3. Only one direction means breakage.** `new→old` failing is a consumer break.
`old→new` failing on its own just means the API became more permissive, and
existing code still compiles. `StorageImage` is the worked example: its prop
widened from `JSX.Element` to `React.ReactNode`, and calling it is unaffected.
Treating that as breaking was wrong.

**4. Generic constraints cannot be synthesised away.** Probing
`interface Box<T extends string>` with a bare `<A0,>` fails the constraint and
reports an identical copy as breaking. Instantiating with `any` or `unknown`
avoids that but makes the comparison trivially pass, which hid the
`ObservableStatus` break entirely. Type parameters are copied verbatim, and the
probe is written into the package's own `dist` so constraint types resolve.

## It composes with the textual diff, it does not replace it

Adding an optional property to an existing interface is invisible here:
assignability holds in both directions, so the verdict is NO CHANGE. That is
correct about severity and blind to the fact that the public surface grew, which
semver calls a minor.

So the two checks answer different questions:

- the gate's textual `.d.ts` diff: **did anything change** → at least a minor
- this differ: **is it breaking** → major

Wiring this in would remove the `gate:accept` judgement call for the common case
and turn the version rule into real semver. It would not remove the diff itself.

## Two more things worth knowing

**5. A `.d.ts` needs a trailing `export {};` or its local types become
exports.** Without it, `getExportsOfModule` reports unexported top-level
declarations as part of the public surface; the same code in a `.ts` file does
not, and `export *` does not filter them out either. `tsc` appends `export {}`
to emitted declaration files for exactly this reason, which is why real
reactfire is unaffected (88 exports, with `InitSdkHook`, `ObservableStatusBase`
and `FirebaseSdks` correctly absent). **A hand-written fixture without it models
something the compiler would never emit.** Every fixture here ends with
`export {};`, and one test guards that.

**6. Stripping private members needs the AST, not line matching.** A member
whose declaration spans lines leaves its own tail behind:

```ts
private callback: (   // the regex deletes this line only
    event: string,    // and these survive as garbage
) => void;
```

The file then fails to parse and the comparison becomes meaningless rather than
failing loudly. `strip-private.mjs` removes whole member spans via the AST, and
also handles `#private` fields, which are equally nominal.

## Tests

```sh
npm run test:apidiff      # no emulators, no network
```

16 tests over fixture pairs in `test/fixtures/api-diff/`, covering each verdict,
root-cause attribution, the cycle path, constrained generics in both directions,
the nominal-typing trap (including that it _does_ misreport without stripping),
and `stripPrivateMembers` itself. Mutation-tested: counting permissive changes
as breaking, dropping root attribution, ignoring removed exports, and either
half of the private-member stripping all kill tests.

The self-comparison control (a version against itself must be NO CHANGE) is the
highest-value one, since it is what caught the nominal-typing bug.

## Before this could ship

- No CI wiring, and no decision on how it slots into the existing `types` check.
- Symbols are reported by bare name, so a root cause in a submodule reads the
  same as one in the entry point.
- `compare()` writes a probe file into the directory it is given, so callers
  must pass a copy.
