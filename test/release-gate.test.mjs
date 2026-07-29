import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMPARE_TAG,
  collectImports,
  compareSpec,
  fetchPublished,
  findCjsMarkers,
  isNoSuchVersion,
  isNotPublished,
  listTypeFiles,
  listEsmFiles,
  diffLines,
  isAllowedExternal,
  isMinorOrMajorBump,
  isReleaseCandidate,
  measurePackage,
  parseVersion,
  runChecks,
  sizesMatch,
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

  // `gate:accept` runs locally, but its numbers are compared against a CI build,
  // and CI stamps a version into the bundle so the two are never byte-identical.
  // Exact matching meant no acknowledgment ever applied in CI.
  it('honours an acknowledgment whose sizes differ slightly, as a CI build does', () => {
    const built = build({ esm: ESM_CLEAN });
    accept(built);
    const recorded = JSON.parse(fs.readFileSync(built.options.acceptedFile, 'utf8'));
    // Stand in for the version stamp: ~+0.5% on the tarball, ~+0.2% on entries.
    recorded.size.packed = Math.round(recorded.size.packed / 1.005);
    recorded.size.sizes['dist/index.js'].gzip = Math.round(recorded.size.sizes['dist/index.js'].gzip / 1.002);
    fs.writeFileSync(built.options.acceptedFile, JSON.stringify(recorded));
    const publishedMetrics = publishedMetricsScaled(built, { entry: 1.5 });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, { ...built.options, publishedMetrics });
    expect(failures.find((f) => f.check === 'size')).toBeUndefined();
  });

  // Tolerant matching must not become "any size is acknowledged".
  it('does not honour an acknowledgment whose sizes moved beyond the tolerance', () => {
    const built = build({ esm: ESM_CLEAN });
    accept(built);
    const recorded = JSON.parse(fs.readFileSync(built.options.acceptedFile, 'utf8'));
    recorded.size.sizes['dist/index.js'].gzip = Math.round(recorded.size.sizes['dist/index.js'].gzip / 1.5);
    fs.writeFileSync(built.options.acceptedFile, JSON.stringify(recorded));
    const publishedMetrics = publishedMetricsScaled(built, { entry: 1.5 });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, { ...built.options, publishedMetrics });
    expect(failures.find((f) => f.check === 'size')).toBeDefined();
  });

  // An acknowledgment taken before a new entry point existed should not cover it.
  it('does not honour an acknowledgment that predates a new entry point', () => {
    const built = build({ esm: ESM_CLEAN });
    accept(built);
    const recorded = JSON.parse(fs.readFileSync(built.options.acceptedFile, 'utf8'));
    delete recorded.size.sizes['dist/index.umd.cjs'];
    fs.writeFileSync(built.options.acceptedFile, JSON.stringify(recorded));
    const publishedMetrics = publishedMetricsScaled(built, { entry: 1.5 });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, { ...built.options, publishedMetrics });
    expect(failures.find((f) => f.check === 'size')).toBeDefined();
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

  // CI stamps an experimental version into package.json before packing
  // (`4.2.6-exp.<sha>` while 4.2.6 is published), so a `!==` comparison read
  // every pull-request build as a release candidate and then, because the
  // numeric core matches, as a patch bump. That would have failed the first PR
  // to legitimately change types, with an error about the version.
  it('does not treat CI’s experimental version stamp as a release', () => {
    const built = withChangedTypes({ version: '4.2.6-exp.a0f4f4c', publishedVersion: '4.2.6' });
    accept(built);
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, built.options);
    expect(failures).toEqual([]);
  });

  // The stamp must not become a blanket exemption: a prerelease of a real bump
  // is still a release, and still has to clear the rule.
  it('still applies the rule to a prerelease of a genuine bump', () => {
    const patch = withChangedTypes({ version: '4.2.7-exp.a0f4f4c', publishedVersion: '4.2.6' });
    accept(patch);
    const patchRun = runChecks(patch.pkgDir, patch.pkg, patch.tarball, patch.published, patch.options);
    expect(patchRun.failures.find((f) => f.check === 'types')?.message).toContain('patch bump');

    const minor = withChangedTypes({ version: '4.3.0-exp.a0f4f4c', publishedVersion: '4.2.6' });
    accept(minor);
    const minorRun = runChecks(minor.pkgDir, minor.pkg, minor.tarball, minor.published, minor.options);
    expect(minorRun.failures).toEqual([]);
  });

  it('allows a patch release that does not touch the type surface', () => {
    const built = build({ esm: ESM_CLEAN, version: '4.2.7', publishedVersion: '4.2.6' });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, built.published, built.options);
    expect(failures).toEqual([]);
  });

  // Bootstrap: nothing has ever been published, so there is genuinely nothing
  // to compare against. The bundle checks still run.
  it('skips the comparison checks when nothing has ever been published', () => {
    const built = build({ esm: ESM_WITH_INLINED_CJS });
    const published = { unavailable: { reason: 'not-published', tag: 'latest' } };
    const { failures, notes } = runChecks(built.pkgDir, built.pkg, built.tarball, published, built.options);
    expect(failures.find((f) => f.check === 'types')).toBeUndefined();
    expect(failures.find((f) => f.check === 'size')).toBeUndefined();
    expect(failures.find((f) => f.check === 'no-cjs-in-esm')).toBeDefined();
    expect(notes.join('\n')).toContain('no published release');
  });

  it('treats a bare null as nothing published', () => {
    const built = build({ esm: ESM_CLEAN });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, null, built.options);
    expect(failures).toEqual([]);
  });

  // The fail-open case. A skip is indistinguishable from a pass in the check's
  // status, so a registry failure that skipped would turn a blip into a
  // silently ungated release.
  it('fails rather than skips when the published release could not be fetched', () => {
    const built = build({ esm: ESM_CLEAN });
    const published = { unavailable: { reason: 'fetch-failed', tag: 'latest', attempts: 3, detail: 'ETIMEDOUT' } };
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, published, built.options);
    const types = failures.find((f) => f.check === 'types');
    expect(types?.message).toContain('could not fetch');
    expect(types?.detail).toContain('ETIMEDOUT');
  });

  // One cause, one failure: `size` cannot run either, but repeating the same
  // registry error under a second check name just buries the real one.
  it('reports a failed fetch once, not once per check', () => {
    const built = build({ esm: ESM_CLEAN });
    const published = { unavailable: { reason: 'fetch-failed', tag: 'latest', attempts: 3, detail: 'ETIMEDOUT' } };
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, published, built.options);
    expect(failures.filter((f) => f.message.includes('could not fetch'))).toHaveLength(1);
  });
});

describe('fetchPublished', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fetch-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const failWith = (stderr) => () => {
    const error = new Error('npm pack failed');
    error.stderr = stderr;
    throw error;
  };

  const ETARGET = 'npm error code ETARGET\nnpm error notarget No matching version found for reactfire@^5.';

  /** Stand in for a real pack: write the tarball the call claims to have made. */
  const packOk = (version) => (cmd, args) => {
    const dest = args[args.indexOf('--pack-destination') + 1];
    const pkgDir = path.join(dest, 'package');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'reactfire', version }));
    execFileSync('tar', ['-czf', path.join(dest, `reactfire-${version}.tgz`), '-C', dest, 'package']);
    return JSON.stringify([{ filename: `reactfire-${version}.tgz` }]);
  };

  /** The `name@spec` argument each call asked npm for. */
  const specsFrom = (calls) => calls.map((args) => args[1]);

  it('classifies a 404 as never published and does not retry it', () => {
    let calls = 0;
    const run = (...args) => {
      calls++;
      return failWith('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/reactfire')(...args);
    };
    const result = fetchPublished(dir, { candidateVersion: '4.2.6', run, attempts: 3, backoffMs: 0 });
    expect(result.unavailable.reason).toBe('not-published');
    // Retrying a missing package just spends CI time to get the same answer.
    expect(calls).toBe(1);
  });

  it('retries a transient failure and reports fetch-failed', () => {
    let calls = 0;
    const run = (...args) => {
      calls++;
      return failWith('npm error network request to https://registry.npmjs.org/reactfire failed, reason: ETIMEDOUT')(...args);
    };
    const result = fetchPublished(dir, { candidateVersion: '4.2.6', run, attempts: 3, backoffMs: 0 });
    expect(result.unavailable.reason).toBe('fetch-failed');
    expect(result.unavailable.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it('succeeds if a retry succeeds', () => {
    let calls = 0;
    const run = (cmd, args) => {
      calls++;
      if (calls === 1) return failWith('ETIMEDOUT')();
      return packOk('4.2.6')(cmd, args);
    };
    const result = fetchPublished(dir, { candidateVersion: '4.2.6', run, attempts: 3, backoffMs: 0 });
    expect(result.version).toBe('4.2.6');
    expect(calls).toBe(2);
  });

  // --- comparison target ---------------------------------------------------

  // The v5 regression, stated as the request that is actually made. Asking for
  // `latest` breaks the whole v4 line the moment 5.0.0 holds that tag: every v4
  // candidate then reads as a release that is not a bump, because a lower major
  // can never register as one (see the version-comparison suite).
  it('asks for the candidate’s own major, not the dist-tag', () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push(args);
      return packOk('4.2.6')(cmd, args);
    };
    const result = fetchPublished(dir, { candidateVersion: '4.2.7', run, attempts: 1, backoffMs: 0 });
    expect(specsFrom(calls)).toEqual(['reactfire@^4']);
    expect(result.version).toBe('4.2.6');
    expect(result.spec).toBe('^4');
  });

  it('uses the stamped version’s major, as CI packs it', () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push(args);
      return packOk('4.2.6')(cmd, args);
    };
    fetchPublished(dir, { candidateVersion: '4.2.6-exp.a0f4f4c', run, attempts: 1, backoffMs: 0 });
    expect(specsFrom(calls)).toEqual(['reactfire@^4']);
  });

  // The v5 line before 5.0.0 ships. Comparing against the v4 surface is not
  // meaningful for classification, but it is better than skipping the checks
  // outright, and the version rule reads a major bump correctly.
  it('falls back to the dist-tag when the major has nothing published', () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push(args);
      if (calls.length === 1) return failWith(ETARGET)();
      return packOk('4.2.6')(cmd, args);
    };
    const result = fetchPublished(dir, { candidateVersion: '5.0.0', run, attempts: 3, backoffMs: 0 });
    expect(specsFrom(calls)).toEqual(['reactfire@^5', 'reactfire@latest']);
    expect(result.version).toBe('4.2.6');
    expect(result.fellBackFrom).toBe('^5');
  });

  // ETARGET means the registry answered, so retrying asks a question already
  // answered. Only the fallback is worth another call.
  it('does not retry an unsatisfiable range', () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push(args);
      return failWith(ETARGET)();
    };
    const result = fetchPublished(dir, { candidateVersion: '5.0.0', run, attempts: 3, backoffMs: 0 });
    expect(specsFrom(calls)).toEqual(['reactfire@^5', 'reactfire@latest']);
    expect(result.unavailable.reason).toBe('no-such-version');
  });

  // Defaulting the target would reinstate the bug `compareSpec` exists to fix,
  // and would do it silently in whichever caller forgot to pass the version.
  it('refuses to guess a comparison target', () => {
    expect(() => fetchPublished(dir, { run: packOk('4.2.6'), attempts: 1 })).toThrow(/candidateVersion/);
  });

  it('honours an explicit spec without needing a candidate version', () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push(args);
      return packOk('4.2.6')(cmd, args);
    };
    fetchPublished(dir, { spec: 'latest', run, attempts: 1, backoffMs: 0 });
    expect(specsFrom(calls)).toEqual(['reactfire@latest']);
  });
});

describe('compareSpec', () => {
  it('targets the candidate’s major', () => {
    expect(compareSpec('4.2.7')).toBe('^4');
    expect(compareSpec('5.0.0')).toBe('^5');
  });

  it('ignores a prerelease suffix', () => {
    expect(compareSpec('4.2.6-exp.a0f4f4c')).toBe('^4');
  });

  // Nothing sane to derive, so fall back rather than build a broken spec.
  it('falls back to the dist-tag for an unparseable version', () => {
    expect(compareSpec(undefined)).toBe(COMPARE_TAG);
    expect(compareSpec('not-a-version')).toBe(COMPARE_TAG);
  });
});

describe('isNoSuchVersion', () => {
  it('recognises the ETARGET shapes', () => {
    expect(isNoSuchVersion('npm error code ETARGET')).toBe(true);
    expect(isNoSuchVersion('npm error notarget No matching version found for reactfire@^5.')).toBe(true);
  });

  // The two get different handling: no package is a skip, no matching version
  // falls back. Conflating them would skip the checks on the whole v5 line.
  it('is distinct from a missing package and from a network error', () => {
    expect(isNoSuchVersion('npm error code E404')).toBe(false);
    expect(isNoSuchVersion('request to https://registry.npmjs.org failed, reason: ETIMEDOUT')).toBe(false);
    expect(isNoSuchVersion(undefined)).toBe(false);
    expect(isNotPublished('npm error code ETARGET')).toBe(false);
  });
});

describe('isNotPublished', () => {
  it('recognises the registry 404 shapes', () => {
    expect(isNotPublished('npm error code E404')).toBe(true);
    expect(isNotPublished('npm error 404 Not Found - GET https://registry.npmjs.org/reactfire')).toBe(true);
  });

  it('does not classify a network error as never published', () => {
    expect(isNotPublished('request to https://registry.npmjs.org failed, reason: ETIMEDOUT')).toBe(false);
    expect(isNotPublished('npm error code ECONNRESET')).toBe(false);
    expect(isNotPublished(undefined)).toBe(false);
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

  // Why the comparison target is derived from the candidate rather than read
  // from the `latest` dist-tag. Compared against a higher major, every v4
  // release reads as "a release, but not a bump", because a lower major can
  // never register as one. Answering that here rather than teaching these
  // helpers about version lines: they are asked a question that only makes
  // sense within one major, so the fix is to not ask it across two.
  it('cannot recognise a bump against a higher major, which is why the target is derived', () => {
    for (const candidate of ['4.2.7', '4.3.0', '4.2.6-exp.a0f4f4c']) {
      expect(isReleaseCandidate(candidate, '5.0.0')).toBe(true);
      expect(isMinorOrMajorBump(candidate, '5.0.0')).toBe(false);
    }
    // Against its own line the same candidates read correctly.
    expect(isMinorOrMajorBump('4.3.0', '4.2.6')).toBe(true);
    expect(isReleaseCandidate('4.2.6-exp.a0f4f4c', '4.2.6')).toBe(false);
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
