#!/usr/bin/env node
/**
 * Built-artifact release gate.
 *
 * Verifies the packed tarball (the exact bytes CI publishes) rather than the
 * working `dist/`, so what we check is what ships.
 *
 * Checks:
 *   1. no CJS interop / dynamic `require` in the ESM entry      (issue #765, item 1)
 *   2. externals stay external, nothing unexpected is inlined   (issue #765, item 2)
 *   3. every path in `exports`/`main`/`module`/`typings` exists  (issue #765, item 4)
 *   4. emitted `.d.ts` match the accepted baseline               (issue #749)
 *   5. bundle size stays within tolerance of the baseline        (issue #765, item 5)
 *
 * Usage:
 *   node scripts/release-gate.mjs [tarball]   verify (packs one if not given)
 *   node scripts/release-gate.mjs --accept    re-record the baseline
 *
 * Checks 4 and 5 compare against `release-gate/baseline/`, which is checked in.
 * Updating it is a deliberate act (`npm run gate:accept`) that shows the type and
 * size delta as a reviewable diff in the pull request, which is what #749 asks
 * for: a non-additive type change cannot land without someone acknowledging it
 * and making the semver call.
 *
 * The exported helpers below are covered by test/release-gate.test.mjs. A gate
 * that silently stops gating is worse than no gate, so the detection logic is
 * pinned by tests rather than by having been checked by hand once.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASELINE_DIR = path.join(ROOT, 'release-gate', 'baseline');
const BASELINE_TYPES = path.join(BASELINE_DIR, 'types');
const BASELINE_METRICS = path.join(BASELINE_DIR, 'metrics.json');

// Bare specifiers the ESM build is allowed to leave as runtime imports.
// Anything else showing up here means a dependency got externalized by accident;
// anything missing from MUST_BE_EXTERNAL means one got inlined by accident.
// Subpaths are matched too: switching to the automatic JSX runtime makes the
// build import `react/jsx-runtime`, which is legitimate and must not be
// reported as an unexpected external.
export const ALLOWED_EXTERNALS = [/^react(\/.*)?$/, /^react-dom(\/.*)?$/, 'use-sync-external-store/shim', /^firebase(\/.*)?$/, /^@firebase\/.*$/];

// Regressing either of these is what shipped as 4.2.4/4.2.5: the CJS
// `use-sync-external-store/shim` got bundled into the ESM output and became a
// dynamic `require()` that throws in any browser bundle. See #759 / #760.
//
// Matched as patterns rather than exact strings so that `react/jsx-runtime`
// counts as react still being external. An exact match would report "react was
// inlined" the moment the build switched to the automatic JSX runtime.
export const MUST_BE_EXTERNAL = [
  { label: 'react', re: /^react(\/.*)?$/ },
  { label: 'use-sync-external-store/shim', re: /^use-sync-external-store\/shim$/ },
];

// Patterns that mean a CJS module was inlined into the ESM output.
//
// Match the bare `require` identifier, not `require(`. The 4.2.5 output that
// shipped the crash never wrote `require(`: rolldown emitted `typeof require`
// guards and `require.apply(this, arguments)`. For the same reason the helper
// names below are only useful on unminified output, since minification renames
// `__commonJS` to a single letter. The identifier check is the load-bearing one.
export const CJS_MARKERS = [
  { name: 'require', re: /(^|[^.\w$])require\b/g },
  { name: 'createRequire', re: /createRequire\b/g },
  { name: '__commonJS', re: /__commonJS\b/g },
  { name: '__toCommonJS', re: /__toCommonJS\b/g },
  // The exact error rolldown's require shim throws in a browser bundle (#759).
  { name: 'rolldown require shim', re: /doesn't expose the `?require`? function/g },
];

// Size tolerance before the gate complains, as a fraction of the baseline.
//
// Deliberately tight. Measured against the real artifacts, the #759 shim
// inlining moved the ESM entry only +3.1% gzip (16815 -> 17330 B) and the
// packed tarball +0.3%, so a 10% band would have missed it entirely. Version
// churn is the noise floor this has to clear: a CI build stamps the version
// into the bundle, which measured at +0.5% on the tarball and +0.2% on the
// entries, so 2% leaves room for that and little else.
//
// This is a coarse guard against gross packaging changes, not a reliable
// inlining detector. `no-cjs-in-esm` and `externals` are what actually catch
// inlining; see release-gate/README.md.
export const SIZE_TOLERANCE = 0.02;

/** Collects failures and informational notes for one run. */
export function createReport() {
  const failures = [];
  const notes = [];
  return {
    failures,
    notes,
    fail: (check, message, detail) => failures.push({ check, message, detail }),
    note: (message) => notes.push(message),
  };
}

function readPackageJson(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

/**
 * Pack a tarball locally and return its path.
 *
 * Packs from a staging dir built out of `git ls-files` plus the built `dist/`,
 * not the working tree directly. `files` includes `src`, so packing the working
 * tree would sweep in any untracked scratch work under src/ (and npm does not
 * reliably exclude a nested node_modules). Staging keeps a local run byte-
 * comparable with what CI packs from a clean checkout, which is what makes the
 * recorded baseline meaningful.
 */
function pack(outDir) {
  const stage = path.join(outDir, 'stage');
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);

  for (const rel of tracked) {
    const dest = path.join(stage, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }

  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) {
    throw new Error('dist/ not found. Run `npx tsc && npx vite build` (or `npm run build`) first.');
  }
  fs.cpSync(dist, path.join(stage, 'dist'), { recursive: true });

  const stdout = execFileSync('npm', ['pack', '--json', '--pack-destination', outDir], {
    cwd: stage,
    // `npm pack` lists every packed file on stderr; drop it.
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // npm 8/9 emit an array here, npm 10+ an object keyed by package name.
  const report = JSON.parse(stdout);
  const entry = Array.isArray(report) ? report[0] : Object.values(report)[0];
  return path.join(outDir, entry.filename);
}

/** Extract a tarball and return the path to its `package/` directory. */
function extract(tarball, outDir) {
  execFileSync('tar', ['-xzf', tarball, '-C', outDir]);
  return path.join(outDir, 'package');
}

/**
 * Collect the bare module specifiers an ESM bundle imports at runtime.
 * Covers static import, export-from, star re-export and dynamic import().
 *
 * The keyword may be followed by whitespace, `{`, `*` or a quote, because
 * minified output writes `import{a}from"react"` and `export*from"rxjs"` with no
 * space. Requiring whitespace here silently blinded the externals check on any
 * minified build, which is the same class of build-output change that caused
 * #759 in the first place.
 */
export function collectImports(source) {
  const specifiers = new Set();
  const patterns = [
    // import ... from "x" / export ... from "x" / export * from "x"
    /\b(?:import|export)[\s{*]([\s\S]*?)\bfrom\s*["']([^"']+)["']/g,
    // bare side-effect import: import"x"
    /\bimport\s*["']([^"']+)["']/g,
    // dynamic import("x")
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      // The first pattern captures the clause too; the specifier is always last.
      const spec = match[match.length - 1];
      // Relative and absolute specifiers resolve inside the package.
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      specifiers.add(spec);
    }
  }
  return [...specifiers].sort();
}

export function isAllowedExternal(spec) {
  return ALLOWED_EXTERNALS.some((rule) => (typeof rule === 'string' ? rule === spec : rule.test(spec)));
}

/** Find CJS-interop markers in an ESM bundle. Returns one entry per marker hit. */
export function findCjsMarkers(source) {
  const found = [];
  for (const { name, re } of CJS_MARKERS) {
    const hits = [...source.matchAll(re)];
    if (hits.length === 0) continue;
    found.push({
      name,
      count: hits.length,
      lines: hits.slice(0, 5).map((hit) => source.slice(0, hit.index).split('\n').length),
    });
  }
  return found;
}

/** Minimal unified-ish diff so a type change is readable in CI logs. */
export function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  // LCS table. The .d.ts files are small (hundreds of lines), so this is fine.
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`  - ${a[i++]}`);
    } else {
      out.push(`  + ${b[j++]}`);
    }
  }
  while (i < a.length) out.push(`  - ${a[i++]}`);
  while (j < b.length) out.push(`  + ${b[j++]}`);
  return out.join('\n');
}

/**
 * List declaration files under `dir`, recursively, as paths relative to `dir`.
 *
 * Recursive because tsconfig emits with `rootDir: ./src`, so a subdirectory of
 * src/ (src/nextjs, pending #739) emits dist/nextjs/*.d.ts. A flat listing would
 * leave that entire type surface silently outside the #749 check.
 */
export function listTypeFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listTypeFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out.sort();
}

function measure(file) {
  const bytes = fs.readFileSync(file);
  return { bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
}

/** Strip a leading "./" so package.json fields and baseline keys agree. */
export function normalizeRelative(rel) {
  return rel.replace(/^\.\//, '');
}

/**
 * Every ESM file the package ships, relative to the package root.
 *
 * Not just the `module` entry. Nothing guarantees the build emits a single
 * chunk, and a second entry point (src/nextjs, pending #739) or rollup deciding
 * to split would put code outside the entry where a CJS inline would be
 * invisible. Chunking is exactly the kind of incidental build-output change
 * this gate exists to be robust against.
 */
export function listEsmFiles(pkgDir, pkg) {
  const entry = normalizeRelative(pkg.module ?? pkg.exports?.['.']?.import ?? '');
  if (!entry) return [];
  const dir = path.dirname(entry);
  const cjs = pkg.main ? normalizeRelative(pkg.main) : null;

  const walk = (abs, rel) => {
    if (!fs.existsSync(abs)) return [];
    const out = [];
    for (const item of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        out.push(...walk(path.join(abs, item.name), childRel));
      } else if (/\.(js|mjs)$/.test(item.name) && childRel !== cjs) {
        out.push(childRel);
      }
    }
    return out;
  };

  // The entry sorts first so its findings are reported before other chunks'.
  return walk(path.join(pkgDir, dir), dir).sort((a, b) => (a === entry ? -1 : b === entry ? 1 : a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function checkNoCjsInEsm(pkgDir, pkg, report) {
  const files = listEsmFiles(pkgDir, pkg);
  if (files.length === 0) {
    const entry = pkg.module ?? pkg.exports?.['.']?.import;
    report.fail('no-cjs-in-esm', `ESM entry ${entry} is missing from the package`);
    return;
  }

  for (const rel of files) {
    const source = fs.readFileSync(path.join(pkgDir, rel), 'utf8');
    for (const { name, count, lines } of findCjsMarkers(source)) {
      report.fail(
        'no-cjs-in-esm',
        `found ${count} occurrence(s) of \`${name}\` in ${rel}`,
        [
          ...lines.map((line) => `    ${rel}:${line}`),
          '',
          '    A CJS module was inlined into the ESM build. This throws',
          '    "Calling `require` for ... in an environment that doesn\'t expose',
          '    the require function" in any browser bundle. Externalize it in',
          '    vite.config.ts. See #759 / #760.',
        ].join('\n'),
      );
    }
  }
}

export function checkExternals(pkgDir, pkg, report) {
  const files = listEsmFiles(pkgDir, pkg);
  if (files.length === 0) return; // already reported

  // Union across every chunk: a split build can import react from a chunk
  // rather than from the entry, and that is still react staying external.
  const byFile = new Map();
  const all = new Set();
  for (const rel of files) {
    const imports = collectImports(fs.readFileSync(path.join(pkgDir, rel), 'utf8'));
    byFile.set(rel, imports);
    imports.forEach((spec) => all.add(spec));
  }

  for (const [rel, imports] of byFile) {
    const unexpected = imports.filter((spec) => !isAllowedExternal(spec));
    if (unexpected.length === 0) continue;
    report.fail(
      'externals',
      `unexpected external import(s) in ${rel}: ${unexpected.join(', ')}`,
      [
        '    These are imported at runtime but are not declared externals.',
        '    Either bundle them, or add them to ALLOWED_EXTERNALS and make sure',
        '    they are declared as dependencies or peerDependencies.',
      ].join('\n'),
    );
  }

  const inlined = MUST_BE_EXTERNAL.filter(({ re }) => ![...all].some((spec) => re.test(spec)));
  if (inlined.length > 0) {
    report.fail(
      'externals',
      `expected external(s) no longer imported by the ESM output: ${inlined.map((m) => m.label).join(', ')}`,
      [
        '    These must stay external. Losing the import means the module was',
        '    inlined, which risks a duplicate React instance or a dynamic',
        '    require() in the ESM output. See #759 / #760.',
      ].join('\n'),
    );
  }

  report.note(`ESM files checked: ${files.join(', ')}`);
  report.note(`external imports: ${[...all].sort().join(', ') || '(none)'}`);
}

export function checkExportsMap(pkgDir, pkg, report) {
  const referenced = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      referenced.add(node);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };
  walk(pkg.exports);
  for (const field of ['main', 'module', 'typings', 'types', 'browser']) {
    if (typeof pkg[field] === 'string') referenced.add(pkg[field]);
  }

  // `module` is written "./dist/index.js" but `main` and `typings` are written
  // "dist/index.umd.cjs" and "dist/index.d.ts". Filtering on a leading "." (as
  // this once did) dropped both before they were ever checked, so the two
  // fields the failure message names were the two it did not look at.
  const isFileRef = (rel) => rel.startsWith('.') || rel.startsWith('/') || /\.(js|cjs|mjs|json|ts)$/.test(rel);
  const missing = [...referenced]
    .filter(isFileRef)
    .map(normalizeRelative)
    .filter((rel) => !fs.existsSync(path.join(pkgDir, rel)));

  if (missing.length > 0) {
    report.fail(
      'exports-map',
      `path(s) referenced by package.json are not in the tarball: ${missing.join(', ')}`,
      ['    The `files` allowlist or the build output and the exports map have', '    drifted apart. Consumers will fail to resolve these.'].join('\n'),
    );
  }
}

export function checkTypes(pkgDir, report, { accept = false, baselineTypes = BASELINE_TYPES } = {}) {
  const distTypes = path.join(pkgDir, 'dist');
  const current = listTypeFiles(distTypes);

  if (accept) {
    fs.rmSync(baselineTypes, { recursive: true, force: true });
    for (const file of current) {
      const dest = path.join(baselineTypes, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(distTypes, file), dest);
    }
    console.log(`recorded ${current.length} type file(s) to release-gate/baseline/types/`);
    return;
  }

  const baseline = listTypeFiles(baselineTypes);
  if (baseline.length === 0) {
    report.fail('types', 'no accepted type baseline found', '    Run `npm run gate:accept` to record one, and commit the result.');
    return;
  }

  const added = current.filter((f) => !baseline.includes(f));
  const removed = baseline.filter((f) => !current.includes(f));
  const changed = [];
  for (const file of current.filter((f) => baseline.includes(f))) {
    const before = fs.readFileSync(path.join(baselineTypes, file), 'utf8');
    const after = fs.readFileSync(path.join(distTypes, file), 'utf8');
    if (before !== after) changed.push({ file, diff: diffLines(before, after) });
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) return;

  const detail = [];
  if (removed.length > 0) detail.push(`    removed declaration file(s): ${removed.join(', ')}`);
  if (added.length > 0) detail.push(`    new declaration file(s): ${added.join(', ')}`);
  for (const { file, diff } of changed) {
    detail.push(`    --- dist/${file}`, diff);
  }
  detail.push(
    '',
    '    The published type surface changed. Decide whether this is additive',
    '    (patch is fine) or non-additive (needs a minor or major bump plus a',
    '    changelog note), then run `npm run gate:accept` and commit the',
    '    updated baseline in the same pull request. See #749.',
  );
  report.fail(
    'types',
    `emitted .d.ts differ from the accepted baseline (${changed.length} changed, ${added.length} added, ${removed.length} removed)`,
    detail.join('\n'),
  );
}

export function checkSize(pkgDir, pkg, tarball, report, { accept = false, baselineMetrics = BASELINE_METRICS } = {}) {
  // `module` is written "./dist/index.js" and `main` "dist/index.umd.cjs";
  // normalize so the baseline keys do not churn if package.json is tidied.
  const entries = [pkg.module, pkg.main].filter((rel) => typeof rel === 'string').map(normalizeRelative);
  const current = {};
  for (const rel of entries) {
    const file = path.join(pkgDir, rel);
    if (fs.existsSync(file)) current[rel] = measure(file);
  }
  const packed = fs.statSync(tarball).size;

  if (accept) {
    fs.mkdirSync(path.dirname(baselineMetrics), { recursive: true });
    fs.writeFileSync(baselineMetrics, `${JSON.stringify({ packed, sizes: current }, null, 2)}\n`);
    console.log(`recorded bundle sizes to release-gate/baseline/metrics.json`);
    return;
  }

  if (!fs.existsSync(baselineMetrics)) {
    report.fail('size', 'no accepted size baseline found', '    Run `npm run gate:accept` to record one, and commit the result.');
    return;
  }

  const recorded = JSON.parse(fs.readFileSync(baselineMetrics, 'utf8'));

  // Guards the whole tarball, not just the entry points. `files` includes
  // `src`, so anything that lands under src/ ships to npm, including a nested
  // node_modules if one is ever present at pack time.
  if (typeof recorded.packed === 'number') {
    const delta = (packed - recorded.packed) / recorded.packed;
    const pct = `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
    report.note(`tarball: ${packed} B (${pct} vs baseline ${recorded.packed} B)`);
    if (Math.abs(delta) > SIZE_TOLERANCE) {
      report.fail(
        'size',
        `packed tarball size moved ${pct} (${recorded.packed} B -> ${packed} B), tolerance is ±${SIZE_TOLERANCE * 100}%`,
        [
          '    Check what the `files` allowlist is picking up (`npm pack --dry-run`).',
          '    If the change is intended, run `npm run gate:accept` and commit the',
          '    updated baseline.',
        ].join('\n'),
      );
    }
  }

  const baseline = recorded.sizes ?? {};
  for (const [rel, now] of Object.entries(current)) {
    const before = baseline[rel];
    if (!before) {
      report.fail('size', `no size baseline for ${rel}`, '    Run `npm run gate:accept` and commit the result.');
      continue;
    }
    const delta = (now.gzip - before.gzip) / before.gzip;
    const pct = `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
    report.note(`${rel}: ${now.gzip} B gzip (${pct} vs baseline ${before.gzip} B)`);
    if (Math.abs(delta) > SIZE_TOLERANCE) {
      report.fail(
        'size',
        `${rel} gzip size moved ${pct} (${before.gzip} B -> ${now.gzip} B), tolerance is ±${SIZE_TOLERANCE * 100}%`,
        [
          '    A jump usually means a dependency got inlined; a drop usually means',
          '    something stopped being bundled. If the change is intended, run',
          '    `npm run gate:accept` and commit the updated baseline.',
        ].join('\n'),
      );
    }
  }
}

/** Run every read-only check against an extracted package directory. */
export function runChecks(pkgDir, pkg, tarball, options = {}) {
  const report = createReport();
  checkNoCjsInEsm(pkgDir, pkg, report);
  checkExternals(pkgDir, pkg, report);
  checkExportsMap(pkgDir, pkg, report);
  checkTypes(pkgDir, report, options);
  checkSize(pkgDir, pkg, tarball, report, options);
  return report;
}

// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const accept = args.includes('--accept');
  const tarballArg = args.find((a) => !a.startsWith('--'));

  const unknown = args.filter((a) => a.startsWith('--') && a !== '--accept');
  if (unknown.length > 0) {
    console.error(`unknown option(s): ${unknown.join(', ')}`);
    console.error('usage: node scripts/release-gate.mjs [tarball] | --accept');
    return 2;
  }
  // Recording a baseline from an arbitrary tarball would silently bless
  // whatever that build contained, including a regression.
  if (accept && tarballArg) {
    console.error('--accept records the baseline from the current build and takes no tarball argument.');
    console.error('Build first (`npx tsc && npx vite build`), then run `npm run gate:accept`.');
    return 2;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reactfire-gate-'));
  try {
    const tarball = tarballArg ? path.resolve(tarballArg) : pack(tmp);
    const pkgDir = extract(tarball, tmp);
    const pkg = readPackageJson(pkgDir);

    console.log(`release gate: reactfire@${pkg.version} (${path.basename(tarball)})\n`);

    if (accept) {
      const report = createReport();
      checkTypes(pkgDir, report, { accept });
      checkSize(pkgDir, pkg, tarball, report, { accept });
      console.log('\nbaseline updated. Review the diff and commit it.');
      return 0;
    }

    const { failures, notes } = runChecks(pkgDir, pkg, tarball);

    for (const note of notes) console.log(`  ${note}`);

    if (failures.length === 0) {
      console.log('\nall checks passed');
      return 0;
    }

    console.error(`\n${failures.length} check(s) failed:\n`);
    for (const { check, message, detail } of failures) {
      console.error(`  [${check}] ${message}`);
      if (detail) console.error(detail);
      console.error('');
    }
    return 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Only run when invoked directly, so tests can import the helpers above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
