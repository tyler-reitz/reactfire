import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectImports,
  findCjsMarkers,
  listTypeFiles,
  listEsmFiles,
  diffLines,
  isAllowedExternal,
  isMinorOrMajorBump,
  measurePackage,
  parseVersion,
  runChecks,
  typesDigest,
  writeAccepted,
} from '../scripts/release-gate.mjs';

/**
 * The release gate exists to catch dist-level regressions that shipped as patch
 * releases (#749, #759). A gate that silently stops gating is worse than no
 * gate, so these tests pin the detection logic against the shapes that actually
 * shipped rather than relying on it having been verified by hand once.
 */

// Condensed from the published reactfire@4.2.5 dist/index.js, which crashed in
// any browser bundle. Note it never writes `require(`: rolldown emits `typeof
// require` guards and `require.apply`. See #759 / #760.
// Built from single-quoted lines so the backticks below stay byte-faithful to
// the published file; a template literal would need them escaped.
const ESM_WITH_INLINED_CJS = [
  'import * as e from "react";',
  'var oe = (e, t) => () => (t || (e((t = { exports: {} }).exports, t), e = null), t.exports), se = ((e) => typeof require < "u" ? require : e)(function(e) {',
  '\tif (typeof require < "u") return require.apply(this, arguments);',
  '\tthrow Error("Calling `require` for \\"" + e + "\\" in an environment that doesn\'t expose the `require` function. See https://rolldown.rs/in-depth/bundling-cjs for more details.");',
  '});',
].join('\n');

// The shape 4.2.6 ships: the shim stays an external import, no require anywhere.
const ESM_CLEAN = `
import * as e from "react";
import { useSyncExternalStore as m } from "use-sync-external-store/shim";
import { getApps as n } from "firebase/app";
export { m as useObservable };
`;

describe('collectImports', () => {
  it('finds specifiers in unminified import statements', () => {
    expect(collectImports('import { a } from "react";')).toEqual(['react']);
  });

  // Regression: requiring whitespace after the keyword silently blinded the
  // externals check on any minified build, which is the same class of
  // build-output change that caused #759.
  it('finds specifiers in minified forms with no whitespace', () => {
    expect(collectImports('import{a}from"react";')).toEqual(['react']);
    expect(collectImports('export{a as b}from"react";')).toEqual(['react']);
    expect(collectImports('export*from"rxjs";')).toEqual(['rxjs']);
    expect(collectImports('import*as e from"react";')).toEqual(['react']);
  });

  it('finds side-effect and dynamic imports', () => {
    expect(collectImports('import"./polyfill";import("firebase/auth");')).toEqual(['firebase/auth']);
  });

  it('ignores relative and absolute specifiers', () => {
    expect(collectImports('import { a } from "./local";import { b } from "/abs";')).toEqual([]);
  });

  it('reports the externals of a clean build', () => {
    expect(collectImports(ESM_CLEAN)).toEqual(['firebase/app', 'react', 'use-sync-external-store/shim']);
  });
});

describe('isAllowedExternal', () => {
  it('allows react, the shim, and firebase entry points', () => {
    for (const spec of ['react', 'use-sync-external-store/shim', 'firebase', 'firebase/auth', '@firebase/app']) {
      expect(isAllowedExternal(spec)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const spec of ['rxjs', 'rxfire/firestore', 'lodash']) {
      expect(isAllowedExternal(spec)).toBe(false);
    }
  });

  // The automatic JSX runtime imports react/jsx-runtime, which is legitimate.
  it('allows react and react-dom subpaths', () => {
    for (const spec of ['react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client']) {
      expect(isAllowedExternal(spec)).toBe(true);
    }
  });
});

describe('findCjsMarkers', () => {
  it('detects the inlined CJS shim that shipped in 4.2.5', () => {
    const names = findCjsMarkers(ESM_WITH_INLINED_CJS).map((m) => m.name);
    expect(names).toContain('require');
    expect(names).toContain('rolldown require shim');
  });

  it('reports line numbers for the first few hits', () => {
    const [first] = findCjsMarkers(ESM_WITH_INLINED_CJS);
    expect(first.count).toBeGreaterThan(0);
    expect(first.lines.length).toBeGreaterThan(0);
    expect(first.lines.length).toBeLessThanOrEqual(5);
  });

  it('stays quiet on a clean ESM bundle', () => {
    expect(findCjsMarkers(ESM_CLEAN)).toEqual([]);
  });

  it('does not match property access or a longer word', () => {
    expect(findCjsMarkers('foo.require;const required = 1;')).toEqual([]);
  });
});

describe('listTypeFiles', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-types-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists declaration files and ignores everything else', () => {
    fs.writeFileSync(path.join(dir, 'index.d.ts'), '');
    fs.writeFileSync(path.join(dir, 'index.js'), '');
    expect(listTypeFiles(dir)).toEqual(['index.d.ts']);
  });

  // tsconfig emits with rootDir ./src, so src/nextjs (pending #739) would emit
  // dist/nextjs/*.d.ts. A flat listing left that surface outside the #749 check.
  it('recurses into subdirectories', () => {
    fs.mkdirSync(path.join(dir, 'nextjs'));
    fs.writeFileSync(path.join(dir, 'index.d.ts'), '');
    fs.writeFileSync(path.join(dir, 'nextjs', 'middleware.d.ts'), '');
    expect(listTypeFiles(dir)).toEqual(['index.d.ts', 'nextjs/middleware.d.ts']);
  });

  it('returns nothing for a missing directory', () => {
    expect(listTypeFiles(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('diffLines', () => {
  it('marks removed and added lines', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc');
    expect(diff).toContain('- b');
    expect(diff).toContain('+ B');
  });

  it('is empty when the inputs match', () => {
    expect(diffLines('a\nb', 'a\nb')).toBe('');
  });
});

describe('runChecks', () => {
  let dir;

  const DEFAULT_TYPES = { 'index.d.ts': 'export declare const a: string;\n' };

  /** Write one extracted-package-shaped directory and return its dir and manifest. */
  const writePackage = (root, { esm, types, extraDist = {}, version }) => {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), esm);
    fs.writeFileSync(path.join(root, 'dist', 'index.umd.cjs'), 'module.exports = {};');
    for (const [file, contents] of Object.entries({ ...extraDist, ...types })) {
      const dest = path.join(root, 'dist', file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, contents);
    }
    const pkg = {
      name: 'reactfire',
      version,
      module: './dist/index.js',
      main: 'dist/index.umd.cjs',
      typings: 'dist/index.d.ts',
      exports: { '.': { import: './dist/index.js', require: './dist/index.umd.cjs' } },
    };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    return { pkgDir: root, pkg };
  };

  /**
   * Build a candidate package plus the "published" one it is compared against.
   *
   * Both sides default to the same contents and the same version, so the types
   * and size checks are no-ops and each test isolates one behaviour. Versions
   * matching also means the release-time version rule stays out of the way
   * unless a test opts into it.
   */
  const build = ({
    esm,
    types = DEFAULT_TYPES,
    extraDist = {},
    version = '4.2.6',
    publishedVersion = version,
    publishedTypes = types,
    publishedEsm = esm,
  } = {}) => {
    const { pkgDir, pkg } = writePackage(path.join(dir, 'package'), { esm, types, extraDist, version });
    const publishedPkg = writePackage(path.join(dir, 'published'), { esm: publishedEsm, types: publishedTypes, version: publishedVersion });

    // Stand-ins for the real tarballs. Equal sizes so the packed delta is 0%.
    const tarball = path.join(dir, 'candidate.tgz');
    const publishedTarball = path.join(dir, 'published.tgz');
    fs.writeFileSync(tarball, 'x'.repeat(1000));
    fs.writeFileSync(publishedTarball, 'x'.repeat(1000));

    const published = { pkgDir: publishedPkg.pkgDir, tarball: publishedTarball, version: publishedVersion };
    // Nothing acknowledged by default: a type change has to fail before a test
    // can prove the acknowledgment is what lets it through.
    const acceptedFile = path.join(dir, 'accepted.json');
    return { pkgDir, pkg, tarball, published, options: { acceptedFile } };
  };

  /** Acknowledge the candidate exactly as `npm run gate:accept` would. */
  const accept = ({ pkgDir, pkg, tarball, published, options }) => writeAccepted(pkgDir, pkg, tarball, published, options.acceptedFile);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-run-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a clean build', () => {
    const { pkgDir, pkg, tarball, published, options } = build({ esm: ESM_CLEAN });
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    expect(failures).toEqual([]);
  });

  it('fails the 4.2.5 shape on both the CJS and externals checks', () => {
    const { pkgDir, pkg, tarball, published, options } = build({ esm: ESM_WITH_INLINED_CJS });
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    const checks = new Set(failures.map((f) => f.check));
    expect(checks).toContain('no-cjs-in-esm');
    expect(checks).toContain('externals');
    // The shim was inlined, so it is no longer imported.
    expect(failures.find((f) => f.check === 'externals').message).toContain('use-sync-external-store/shim');
  });

  it('fails when a dependency leaks out as an unexpected external', () => {
    const { pkgDir, pkg, tarball, published, options } = build({ esm: `${ESM_CLEAN}\nimport { map } from "rxjs";` });
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    const externals = failures.find((f) => f.check === 'externals');
    expect(externals?.message).toContain('rxjs');
  });

  it('fails when the emitted types drift from the published release', () => {
    const { pkgDir, pkg, tarball, published, options } = build({
      esm: ESM_CLEAN,
      types: { ...DEFAULT_TYPES, 'useObservable.d.ts': 'export declare const changed: number;\n' },
      publishedTypes: { ...DEFAULT_TYPES, 'useObservable.d.ts': 'export declare const original: string;\n' },
    });
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    const types = failures.find((f) => f.check === 'types');
    expect(types).toBeDefined();
    expect(types.message).toContain('reactfire@4.2.6');
    expect(types.detail).toContain('- export declare const original: string;');
    expect(types.detail).toContain('+ export declare const changed: number;');
  });

  it('fails when a path in the exports map is missing from the package', () => {
    const { pkgDir, pkg, tarball, published, options } = build({ esm: ESM_CLEAN });
    fs.rmSync(path.join(pkgDir, 'dist', 'index.umd.cjs'));
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    expect(failures.find((f) => f.check === 'exports-map')?.message).toContain('dist/index.umd.cjs');
  });

  // Regression: `main` and `typings` are written without a "./" prefix, and the
  // check used to filter on a leading ".", so the two fields its own failure
  // message named were the two it never looked at.
  it('fails when typings is missing, even though it has no "./" prefix', () => {
    const { pkgDir, pkg, tarball, published, options } = build({ esm: ESM_CLEAN });
    fs.rmSync(path.join(pkgDir, 'dist', 'index.d.ts'));
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    expect(failures.find((f) => f.check === 'exports-map')?.message).toContain('dist/index.d.ts');
  });

  it('fails when main is missing and no exports map duplicates it', () => {
    const { pkgDir, pkg, tarball, published, options } = build({ esm: ESM_CLEAN });
    delete pkg.exports;
    fs.rmSync(path.join(pkgDir, 'dist', 'index.umd.cjs'));
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    expect(failures.find((f) => f.check === 'exports-map')?.message).toContain('dist/index.umd.cjs');
  });

  it('does not treat bare package specifiers as missing files', () => {
    const { pkgDir, pkg, tarball, published, options } = build({ esm: ESM_CLEAN });
    pkg.exports['./polyfill'] = { import: 'react' };
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    expect(failures.find((f) => f.check === 'exports-map')).toBeUndefined();
  });

  // The #739 case: a new entry point emits a new declaration file. The
  // recursion that finds it is only useful if a new file actually fails.
  it('fails when a declaration file is added', () => {
    const { pkgDir, pkg, tarball, published, options } = build({ esm: ESM_CLEAN });
    fs.mkdirSync(path.join(pkgDir, 'dist', 'nextjs'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'nextjs', 'middleware.d.ts'), 'export declare const mw: string;\n');
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    const types = failures.find((f) => f.check === 'types');
    expect(types?.message).toContain('1 added');
    expect(types?.detail).toContain('nextjs/middleware.d.ts');
  });

  it('fails when a declaration file is removed', () => {
    const { pkgDir, pkg, tarball, published, options } = build({
      esm: ESM_CLEAN,
      publishedTypes: { ...DEFAULT_TYPES, 'storage.d.ts': 'export declare const s: string;\n' },
    });
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    const types = failures.find((f) => f.check === 'types');
    expect(types?.message).toContain('1 removed');
    expect(types?.detail).toContain('storage.d.ts');
  });

  // A CJS inline in a non-entry chunk was previously invisible: both bundle
  // checks only ever opened pkg.module.
  it('detects inlined CJS in a non-entry chunk', () => {
    const { pkgDir, pkg, tarball, published, options } = build({
      esm: `${ESM_CLEAN}\nimport "./chunk-abc.js";`,
      extraDist: { 'chunk-abc.js': ESM_WITH_INLINED_CJS },
    });
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    const cjs = failures.find((f) => f.check === 'no-cjs-in-esm');
    expect(cjs?.message).toContain('chunk-abc.js');
  });

  it('accepts an expected external imported from a chunk rather than the entry', () => {
    const { pkgDir, pkg, tarball, published, options } = build({
      esm: 'import * as e from "react";\nimport "./chunk-abc.js";\nexport { e };',
      extraDist: { 'chunk-abc.js': 'import { useSyncExternalStore as m } from "use-sync-external-store/shim";\nexport { m };' },
    });
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    expect(failures.find((f) => f.check === 'externals')).toBeUndefined();
  });

  it('does not scan the UMD build for CJS markers', () => {
    const { pkgDir, pkg, tarball, published, options } = build({ esm: ESM_CLEAN });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'index.umd.cjs'), 'var x = require("react");');
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    expect(failures.find((f) => f.check === 'no-cjs-in-esm')).toBeUndefined();
  });

  it('treats react/jsx-runtime as react staying external', () => {
    const { pkgDir, pkg, tarball, published, options } = build({
      esm: 'import { jsx } from "react/jsx-runtime";\nimport { useSyncExternalStore as m } from "use-sync-external-store/shim";\nexport { jsx, m };',
    });
    const { failures } = runChecks(pkgDir, pkg, tarball, published, options);
    expect(failures.find((f) => f.check === 'externals')).toBeUndefined();
  });

  /**
   * Metrics for the published side, scaled so the candidate lands a chosen
   * distance away. Measuring a real package cannot hit a precise delta, and the
   * tolerance value is what these tests exist to pin.
   */
  const publishedMetricsScaled = ({ pkgDir, pkg, tarball }, { entry = 1, packed = 1 } = {}) => {
    const metrics = measurePackage(pkgDir, pkg, tarball);
    metrics.sizes['dist/index.js'].gzip = Math.round(metrics.sizes['dist/index.js'].gzip / entry);
    metrics.packed = Math.round(metrics.packed / packed);
    return metrics;
  };

  // The size check had no coverage at all: deleting it, or setting the
  // tolerance to 100, left every test green.
  it('fails when an entry point grows beyond the tolerance', () => {
    const built = build({ esm: ESM_CLEAN });
    const publishedMetrics = publishedMetricsScaled(built, { entry: 1.5 });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, { ...built.options, publishedMetrics });
    expect(failures.find((f) => f.check === 'size')?.message).toContain('dist/index.js');
  });

  it('fails when the packed tarball grows beyond the tolerance', () => {
    const built = build({ esm: ESM_CLEAN });
    const publishedMetrics = publishedMetricsScaled(built, { packed: 100 });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, { ...built.options, publishedMetrics });
    expect(failures.find((f) => f.check === 'size')?.message).toContain('packed tarball');
  });

  // The band has to sit below the movement the #759 inlining actually produced
  // (+3.1% on the ESM entry) and above CI's version-stamp churn (~+0.5%).
  // A 10% tolerance, which is what this shipped with first, misses this.
  it('fails on a delta the size of the #759 inlining', () => {
    const built = build({ esm: ESM_CLEAN });
    const publishedMetrics = publishedMetricsScaled(built, { entry: 1.031 });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, { ...built.options, publishedMetrics });
    expect(failures.find((f) => f.check === 'size')?.message).toContain('dist/index.js');
  });

  it('tolerates size movement within the tolerance', () => {
    const built = build({ esm: ESM_CLEAN });
    const publishedMetrics = publishedMetricsScaled(built, { entry: 1.01 });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, { ...built.options, publishedMetrics });
    expect(failures.find((f) => f.check === 'size')).toBeUndefined();
  });

  // An out-of-tolerance size move can be intended (dropping a dependency, say).
  // The acknowledgment is what lets it through, and it has to be taken after
  // the change, not before.
  it('lets an acknowledged size move through', () => {
    const built = build({ esm: ESM_CLEAN });
    accept(built);
    const publishedMetrics = publishedMetricsScaled(built, { entry: 1.5 });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, { ...built.options, publishedMetrics });
    expect(failures.find((f) => f.check === 'size')).toBeUndefined();
  });

  // --- acknowledgment (#749) ---------------------------------------------

  const withChangedTypes = (overrides = {}) =>
    build({
      esm: ESM_CLEAN,
      types: { ...DEFAULT_TYPES, 'useObservable.d.ts': 'export declare const changed: number;\n' },
      publishedTypes: { ...DEFAULT_TYPES, 'useObservable.d.ts': 'export declare const original: string;\n' },
      ...overrides,
    });

  it('lets an acknowledged type change through', () => {
    const built = withChangedTypes();
    accept(built);
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, built.options);
    expect(failures).toEqual([]);
  });

  // The acknowledgment fingerprints the surface it covers, so editing the types
  // afterwards has to invalidate it. Otherwise one gate:accept would bless every
  // later change in the same pull request.
  it('does not let an acknowledgment cover a later type change', () => {
    const built = withChangedTypes();
    accept(built);
    fs.writeFileSync(path.join(built.pkgDir, 'dist', 'useObservable.d.ts'), 'export declare const changedAgain: boolean;\n');
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, built.options);
    expect(failures.find((f) => f.check === 'types')).toBeDefined();
  });

  // A new release on npm expires the acknowledgment: what it was reviewed
  // against is gone, so the call has to be made again.
  it('rejects an acknowledgment taken against a different published version', () => {
    const built = withChangedTypes();
    accept(built);
    const stale = { ...built.published, version: '4.3.0' };
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, stale, built.options);
    const types = failures.find((f) => f.check === 'types');
    expect(types?.detail).toContain('was taken against 4.2.6');
  });

  // --- release-time version rule (#749) ----------------------------------

  // package.json carries the published version during normal development, so
  // there is no bump to judge and the rule has to stay quiet.
  it('does not assert a version bump while package.json matches the published version', () => {
    const built = withChangedTypes();
    accept(built);
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, built.options);
    expect(failures).toEqual([]);
  });

  // This is 4.2.4: a real type change cut as a patch, which is what reddened
  // consumer builds on an unattended caret upgrade.
  it('fails a release that ships a type change as a patch bump', () => {
    const built = withChangedTypes({ version: '4.2.7', publishedVersion: '4.2.6' });
    accept(built);
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, built.options);
    expect(failures.find((f) => f.check === 'types')?.message).toContain('patch bump');
  });

  it('allows a release that ships a type change as a minor bump', () => {
    const built = withChangedTypes({ version: '4.3.0', publishedVersion: '4.2.6' });
    accept(built);
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, built.options);
    expect(failures).toEqual([]);
  });

  it('allows a patch release that does not touch the type surface', () => {
    const built = build({ esm: ESM_CLEAN, version: '4.2.7', publishedVersion: '4.2.6' });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, built.options);
    expect(failures).toEqual([]);
  });

  // A registry outage must not wedge CI on a pull request that has nothing to
  // do with the published surface. The bundle checks still run.
  it('skips the comparison checks when there is no published release', () => {
    const built = build({ esm: ESM_WITH_INLINED_CJS });
    const { failures, notes } = runChecks(built.pkgDir, built.pkg, built.tarball, null, built.options);
    expect(failures.find((f) => f.check === 'types')).toBeUndefined();
    expect(failures.find((f) => f.check === 'size')).toBeUndefined();
    expect(failures.find((f) => f.check === 'no-cjs-in-esm')).toBeDefined();
    expect(notes.join('\n')).toContain('no published release');
  });
});

describe('typesDigest', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-digest-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('changes when a declaration changes', () => {
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export declare const a: string;\n');
    const before = typesDigest(dir);
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export declare const a: number;\n');
    expect(typesDigest(dir)).not.toBe(before);
  });

  it('changes when a declaration file is added', () => {
    fs.writeFileSync(path.join(dir, 'index.d.ts'), 'export declare const a: string;\n');
    const before = typesDigest(dir);
    fs.writeFileSync(path.join(dir, 'extra.d.ts'), 'export declare const b: string;\n');
    expect(typesDigest(dir)).not.toBe(before);
  });

  // The digest concatenates names and contents, so the separators have to keep
  // "a.d.ts holding X" apart from "b.d.ts holding Y" when the bytes line up.
  it('distinguishes the same contents under different file names', () => {
    fs.writeFileSync(path.join(dir, 'a.d.ts'), 'x');
    const before = typesDigest(dir);
    fs.rmSync(path.join(dir, 'a.d.ts'));
    fs.writeFileSync(path.join(dir, 'b.d.ts'), 'x');
    expect(typesDigest(dir)).not.toBe(before);
  });
});

describe('version comparison', () => {
  it('parses a plain version', () => {
    expect(parseVersion('4.2.6')).toEqual([4, 2, 6]);
  });

  it('ignores a prerelease suffix', () => {
    expect(parseVersion('5.0.0-rc.2')).toEqual([5, 0, 0]);
  });

  it('returns null for something unparseable', () => {
    expect(parseVersion('not-a-version')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it('treats a patch bump as not minor-or-major', () => {
    expect(isMinorOrMajorBump('4.2.7', '4.2.6')).toBe(false);
  });

  it('treats minor and major bumps as minor-or-major', () => {
    expect(isMinorOrMajorBump('4.3.0', '4.2.6')).toBe(true);
    expect(isMinorOrMajorBump('5.0.0', '4.2.6')).toBe(true);
  });

  // "Cannot tell" is not "fine": the caller must not read null as a pass.
  it('returns null when either side is unparseable', () => {
    expect(isMinorOrMajorBump('nope', '4.2.6')).toBeNull();
    expect(isMinorOrMajorBump('4.3.0', 'nope')).toBeNull();
  });
});

describe('listEsmFiles', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-esm-'));
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const pkg = { module: './dist/index.js', main: 'dist/index.umd.cjs' };

  it('lists every ESM chunk with the entry first, excluding the UMD build', () => {
    for (const f of ['index.js', 'chunk-b.js', 'chunk-a.mjs', 'index.umd.cjs', 'index.js.map']) {
      fs.writeFileSync(path.join(dir, 'dist', f), '');
    }
    expect(listEsmFiles(dir, pkg)).toEqual(['dist/index.js', 'dist/chunk-a.mjs', 'dist/chunk-b.js']);
  });

  it('recurses into nested chunk directories', () => {
    fs.mkdirSync(path.join(dir, 'dist', 'nextjs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), '');
    fs.writeFileSync(path.join(dir, 'dist', 'nextjs', 'middleware.js'), '');
    expect(listEsmFiles(dir, pkg)).toEqual(['dist/index.js', 'dist/nextjs/middleware.js']);
  });

  it('returns nothing when the dist directory is absent', () => {
    fs.rmSync(path.join(dir, 'dist'), { recursive: true });
    expect(listEsmFiles(dir, pkg)).toEqual([]);
  });
});
