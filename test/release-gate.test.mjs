import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectImports, findCjsMarkers, listTypeFiles, listEsmFiles, diffLines, isAllowedExternal, runChecks } from '../scripts/release-gate.mjs';

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

  const build = ({ esm, types = { 'index.d.ts': 'export declare const a: string;\n' }, extraDist = {} }) => {
    const pkgDir = path.join(dir, 'package');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'index.js'), esm);
    fs.writeFileSync(path.join(pkgDir, 'dist', 'index.umd.cjs'), 'module.exports = {};');
    for (const [file, contents] of Object.entries(extraDist)) {
      const dest = path.join(pkgDir, 'dist', file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, contents);
    }
    for (const [file, contents] of Object.entries(types)) {
      fs.writeFileSync(path.join(pkgDir, 'dist', file), contents);
    }

    const pkg = {
      name: 'reactfire',
      version: '0.0.0-test',
      module: './dist/index.js',
      main: 'dist/index.umd.cjs',
      typings: 'dist/index.d.ts',
      exports: { '.': { import: './dist/index.js', require: './dist/index.umd.cjs' } },
    };
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg));

    // Stand-ins for the real tarball and baseline; sizes are recorded from this
    // build so the size check is a no-op and the other checks are isolated.
    const tarball = path.join(dir, 'fake.tgz');
    fs.writeFileSync(tarball, 'x'.repeat(1000));

    const baselineTypes = path.join(dir, 'baseline-types');
    fs.mkdirSync(baselineTypes, { recursive: true });
    for (const [file, contents] of Object.entries(types)) {
      fs.writeFileSync(path.join(baselineTypes, file), contents);
    }

    const gzipOf = (p) => gzipSync(fs.readFileSync(p), { level: 9 }).length;
    const baselineMetrics = path.join(dir, 'metrics.json');
    fs.writeFileSync(
      baselineMetrics,
      JSON.stringify({
        packed: 1000,
        sizes: {
          'dist/index.js': { gzip: gzipOf(path.join(pkgDir, 'dist', 'index.js')) },
          'dist/index.umd.cjs': { gzip: gzipOf(path.join(pkgDir, 'dist', 'index.umd.cjs')) },
        },
      }),
    );

    return { pkgDir, pkg, tarball, options: { baselineTypes, baselineMetrics } };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-run-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a clean build', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures).toEqual([]);
  });

  it('fails the 4.2.5 shape on both the CJS and externals checks', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_WITH_INLINED_CJS });
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    const checks = new Set(failures.map((f) => f.check));
    expect(checks).toContain('no-cjs-in-esm');
    expect(checks).toContain('externals');
    // The shim was inlined, so it is no longer imported.
    expect(failures.find((f) => f.check === 'externals').message).toContain('use-sync-external-store/shim');
  });

  it('fails when a dependency leaks out as an unexpected external', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: `${ESM_CLEAN}\nimport { map } from "rxjs";` });
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    const externals = failures.find((f) => f.check === 'externals');
    expect(externals?.message).toContain('rxjs');
  });

  it('fails when the emitted types drift from the baseline', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'useObservable.d.ts'), 'export declare const changed: number;\n');
    fs.writeFileSync(path.join(options.baselineTypes, 'useObservable.d.ts'), 'export declare const original: string;\n');
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    const types = failures.find((f) => f.check === 'types');
    expect(types).toBeDefined();
    expect(types.detail).toContain('- export declare const original: string;');
    expect(types.detail).toContain('+ export declare const changed: number;');
  });

  it('fails when a path in the exports map is missing from the package', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    fs.rmSync(path.join(pkgDir, 'dist', 'index.umd.cjs'));
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'exports-map')?.message).toContain('dist/index.umd.cjs');
  });

  // Regression: `main` and `typings` are written without a "./" prefix, and the
  // check used to filter on a leading ".", so the two fields its own failure
  // message named were the two it never looked at.
  it('fails when typings is missing, even though it has no "./" prefix', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    fs.rmSync(path.join(pkgDir, 'dist', 'index.d.ts'));
    fs.rmSync(path.join(options.baselineTypes, 'index.d.ts'));
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'exports-map')?.message).toContain('dist/index.d.ts');
  });

  it('fails when main is missing and no exports map duplicates it', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    delete pkg.exports;
    fs.rmSync(path.join(pkgDir, 'dist', 'index.umd.cjs'));
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'exports-map')?.message).toContain('dist/index.umd.cjs');
  });

  it('does not treat bare package specifiers as missing files', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    pkg.exports['./polyfill'] = { import: 'react' };
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'exports-map')).toBeUndefined();
  });

  // The #739 case: a new entry point emits a new declaration file. The
  // recursion that finds it is only useful if a new file actually fails.
  it('fails when a declaration file is added', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    fs.mkdirSync(path.join(pkgDir, 'dist', 'nextjs'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'nextjs', 'middleware.d.ts'), 'export declare const mw: string;\n');
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    const types = failures.find((f) => f.check === 'types');
    expect(types?.message).toContain('1 added');
    expect(types?.detail).toContain('nextjs/middleware.d.ts');
  });

  it('fails when a declaration file is removed', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    fs.writeFileSync(path.join(options.baselineTypes, 'storage.d.ts'), 'export declare const s: string;\n');
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    const types = failures.find((f) => f.check === 'types');
    expect(types?.message).toContain('1 removed');
    expect(types?.detail).toContain('storage.d.ts');
  });

  // A CJS inline in a non-entry chunk was previously invisible: both bundle
  // checks only ever opened pkg.module.
  it('detects inlined CJS in a non-entry chunk', () => {
    const { pkgDir, pkg, tarball, options } = build({
      esm: `${ESM_CLEAN}\nimport "./chunk-abc.js";`,
      extraDist: { 'chunk-abc.js': ESM_WITH_INLINED_CJS },
    });
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    const cjs = failures.find((f) => f.check === 'no-cjs-in-esm');
    expect(cjs?.message).toContain('chunk-abc.js');
  });

  it('accepts an expected external imported from a chunk rather than the entry', () => {
    const { pkgDir, pkg, tarball, options } = build({
      esm: 'import * as e from "react";\nimport "./chunk-abc.js";\nexport { e };',
      extraDist: { 'chunk-abc.js': 'import { useSyncExternalStore as m } from "use-sync-external-store/shim";\nexport { m };' },
    });
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'externals')).toBeUndefined();
  });

  it('does not scan the UMD build for CJS markers', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'index.umd.cjs'), 'var x = require("react");');
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'no-cjs-in-esm')).toBeUndefined();
  });

  it('treats react/jsx-runtime as react staying external', () => {
    const { pkgDir, pkg, tarball, options } = build({
      esm: 'import { jsx } from "react/jsx-runtime";\nimport { useSyncExternalStore as m } from "use-sync-external-store/shim";\nexport { jsx, m };',
    });
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'externals')).toBeUndefined();
  });

  // The size check had no coverage at all: deleting it, or setting the
  // tolerance to 100, left every test green.
  it('fails when an entry point grows beyond the tolerance', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    const metrics = JSON.parse(fs.readFileSync(options.baselineMetrics, 'utf8'));
    metrics.sizes['dist/index.js'].gzip = Math.round(metrics.sizes['dist/index.js'].gzip / 1.5);
    fs.writeFileSync(options.baselineMetrics, JSON.stringify(metrics));
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'size')?.message).toContain('dist/index.js');
  });

  it('fails when the packed tarball grows beyond the tolerance', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    const metrics = JSON.parse(fs.readFileSync(options.baselineMetrics, 'utf8'));
    metrics.packed = 10;
    fs.writeFileSync(options.baselineMetrics, JSON.stringify(metrics));
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'size')?.message).toContain('packed tarball');
  });

  // The band has to sit below the movement the #759 inlining actually produced
  // (+3.1% on the ESM entry) and above CI's version-stamp churn (~+0.5%).
  // A 10% tolerance, which is what this shipped with first, misses this.
  it('fails on a delta the size of the #759 inlining', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    const metrics = JSON.parse(fs.readFileSync(options.baselineMetrics, 'utf8'));
    metrics.sizes['dist/index.js'].gzip = Math.round(metrics.sizes['dist/index.js'].gzip / 1.031);
    fs.writeFileSync(options.baselineMetrics, JSON.stringify(metrics));
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'size')?.message).toContain('dist/index.js');
  });

  it('tolerates size movement within the tolerance', () => {
    const { pkgDir, pkg, tarball, options } = build({ esm: ESM_CLEAN });
    const metrics = JSON.parse(fs.readFileSync(options.baselineMetrics, 'utf8'));
    metrics.sizes['dist/index.js'].gzip = Math.round(metrics.sizes['dist/index.js'].gzip / 1.01);
    fs.writeFileSync(options.baselineMetrics, JSON.stringify(metrics));
    const { failures } = runChecks(pkgDir, pkg, tarball, options);
    expect(failures.find((f) => f.check === 'size')).toBeUndefined();
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
