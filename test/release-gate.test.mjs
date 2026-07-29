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
  listEsmFiles,
  isAllowedExternal,
  measurePackage,
  parseVersion,
  runChecks,
  sizesMatch,
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
   * Both sides default to the same contents and the same version, so the size
   * check is a no-op and each test isolates one behaviour. `types` still writes
   * declaration files because `exports-map` checks that the path in `typings`
   * exists; nothing diffs them here.
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
    // Nothing acknowledged by default: a size move has to fail before a test can
    // prove the acknowledgment is what lets it through.
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

  // Bootstrap: nothing has ever been published, so there is genuinely nothing
  // to compare against. The bundle checks still run.
  it('skips the size comparison when nothing has ever been published', () => {
    const built = build({ esm: ESM_WITH_INLINED_CJS });
    const published = { unavailable: { reason: 'not-published', spec: '^4' } };
    const { failures, notes } = runChecks(built.pkgDir, built.pkg, built.tarball, published, built.options);
    expect(failures.find((f) => f.check === 'size')).toBeUndefined();
    expect(failures.find((f) => f.check === 'no-cjs-in-esm')).toBeDefined();
    expect(notes.join('\n')).toContain('no published release');
  });

  // The v5 line before 5.0.0 ships, if the dist-tag fallback also fails to
  // resolve. Nothing is being withheld, so it is a skip and not a failure.
  it('skips the size comparison when nothing matches the major', () => {
    const built = build({ esm: ESM_CLEAN });
    const published = { unavailable: { reason: 'no-such-version', spec: '^5' } };
    const { failures, notes } = runChecks(built.pkgDir, built.pkg, built.tarball, published, built.options);
    expect(failures).toEqual([]);
    expect(notes.join('\n')).toContain('nothing published matching ^5');
  });

  it('treats a bare null as nothing published', () => {
    const built = build({ esm: ESM_CLEAN });
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, null, built.options);
    expect(failures).toEqual([]);
  });

  // The fail-open case, and the reason `size` reports this itself rather than
  // deferring. A skip is indistinguishable from a pass in the check's status, so
  // a registry failure that skipped would turn a blip into a silently ungated
  // release. `types` used to carry this; with `types` gone, leaving `size` quiet
  // here would have reintroduced the fail-open through a refactor.
  it('fails rather than skips when the published release could not be fetched', () => {
    const built = build({ esm: ESM_CLEAN });
    const published = { unavailable: { reason: 'fetch-failed', spec: '^4', attempts: 3, detail: 'ETIMEDOUT' } };
    const { failures } = runChecks(built.pkgDir, built.pkg, built.tarball, published, built.options);
    const size = failures.find((f) => f.check === 'size');
    expect(size?.message).toContain('could not fetch');
    expect(size?.detail).toContain('ETIMEDOUT');
  });

  it('reports a failed fetch once', () => {
    const built = build({ esm: ESM_CLEAN });
    const published = { unavailable: { reason: 'fetch-failed', spec: '^4', attempts: 3, detail: 'ETIMEDOUT' } };
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

describe('parseVersion', () => {
  it('parses a plain version', () => {
    expect(parseVersion('4.2.6')).toEqual([4, 2, 6]);
  });

  it('ignores a prerelease suffix', () => {
    expect(parseVersion('5.0.0-rc.2')).toEqual([5, 0, 0]);
  });

  // `compareSpec` falls back to the dist-tag on null rather than building a
  // broken spec out of a version it could not read.
  it('returns null for something unparseable', () => {
    expect(parseVersion('not-a-version')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
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
