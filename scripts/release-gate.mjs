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
 *   4. emitted `.d.ts` match the last published release          (issue #749)
 *   5. bundle size stays within tolerance of it                  (issue #765, item 5)
 *
 * Usage:
 *   node scripts/release-gate.mjs [tarball]   verify (packs one if not given)
 *   node scripts/release-gate.mjs --accept    record an acknowledgment
 *
 * Checks 4 and 5 compare against the tarball currently on npm, which is what
 * #749 specifies. Comparing against a copy checked into the repo would drift the
 * moment a release is published without refreshing it, and reactfire is
 * published by hand, so that path is live. The release compared against is the
 * newest one sharing the candidate's major, not the `latest` dist-tag; see
 * `compareSpec`.
 *
 * Because there is no checked-in copy to diff against, the acknowledgment is a
 * fingerprint: `release-gate/accepted.json` records a digest of the type surface
 * and the npm version it was taken against. A type change fails the gate until
 * someone runs `npm run gate:accept` and commits that file, so the semver call
 * still has to be made at pull-request time and still shows up in review. The
 * file is a few lines rather than a mirrored copy of every `.d.ts`, so there is
 * no second type surface to maintain.
 *
 * An acknowledgment is scoped to the version it was taken against. When a new
 * release lands on npm, a stale acknowledgment stops matching and has to be
 * retaken, so it cannot silently bless a later change.
 *
 * The exported helpers below are covered by test/release-gate.test.mjs. A gate
 * that silently stops gating is worse than no gate, so the detection logic is
 * pinned by tests rather than by having been checked by hand once.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ACCEPTED_FILE = path.join(ROOT, 'release-gate', 'accepted.json');

// Fallback comparison target, used only when the candidate's own major has
// nothing published yet. `latest` is what an unpinned consumer upgrade resolves
// to, which is the population #749 is about.
export const COMPARE_TAG = 'latest';

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

/** Whether an `npm pack` failure means the package itself has never been published. */
export function isNotPublished(stderr) {
  return /\bE404\b|404 Not Found|is not in this registry/i.test(String(stderr ?? ''));
}

/**
 * Whether an `npm pack` failure means "the package exists, but nothing matches
 * this range". npm reports that as ETARGET, distinct from the E404 it returns
 * for a package that does not exist at all. The two need different handling: no
 * package is a legitimate skip, whereas no release on this major just means the
 * comparison has to fall back to another one.
 */
export function isNoSuchVersion(stderr) {
  return /\bETARGET\b|\bnotarget\b|No matching version found/i.test(String(stderr ?? ''));
}

/**
 * The npm spec to compare a candidate against: the newest release sharing its
 * major.
 *
 * Not the `latest` dist-tag, which breaks the entire v4 line the moment 5.0.0
 * takes that tag. Every v4 candidate then reads as a release candidate that is
 * not a bump (`isMinorOrMajorBump('4.2.7', '5.0.0')` is false, because a lower
 * major can never register as one), so maintenance releases, minors, and even
 * stamped canary builds all fail against a surface from a different major line.
 * The blast radius is every v4 pull request, not just release cuts. Deriving the
 * target from the candidate keeps a v4 build comparing against v4.
 *
 * Derived rather than read from a per-branch dist-tag on purpose. A `v4` tag
 * would have to be maintained correctly on every publish, and reactfire is
 * published by hand on a broken CI/CD path, so it would drift. That is the same
 * reasoning that ruled out a committed baseline.
 */
export function compareSpec(candidateVersion) {
  const parsed = parseVersion(candidateVersion);
  return parsed ? `^${parsed[0]}` : COMPARE_TAG;
}

/** Block the current thread. Used for retry backoff; the gate is synchronous. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One `npm pack <name>@<spec>` with retries. Internal; see `fetchPublished`. */
function packPublished(dir, spec, { name, attempts, backoffMs, run }) {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const stdout = run('npm', ['pack', `${name}@${spec}`, '--json', '--pack-destination', dir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const report = JSON.parse(stdout);
      const entry = Array.isArray(report) ? report[0] : Object.values(report)[0];
      const tarball = path.join(dir, entry.filename);
      const pkgDir = extract(tarball, dir);
      return { pkgDir, tarball, version: readPackageJson(pkgDir).version, spec };
    } catch (error) {
      last = String(error.stderr ?? error.message ?? '');
      // Neither a missing package nor an unsatisfiable range improves on a retry.
      if (isNotPublished(last)) return { unavailable: { reason: 'not-published', spec, detail: last.trim().split('\n')[0] ?? '' } };
      if (isNoSuchVersion(last)) return { unavailable: { reason: 'no-such-version', spec, detail: last.trim().split('\n')[0] ?? '' } };
      if (attempt < attempts) sleepSync(backoffMs * attempt);
    }
  }
  return { unavailable: { reason: 'fetch-failed', spec, attempts, detail: last.trim().split('\n').slice(-1)[0] ?? '' } };
}

/**
 * Download the published tarball to compare against, and extract it.
 *
 * Returns `{ pkgDir, tarball, version, spec }` on success, or `{ unavailable }`
 * describing why not.
 *
 * Targets the candidate's own major (see `compareSpec`), falling back to the
 * `latest` dist-tag when that major has nothing published. The fallback is what
 * covers the v5 line before 5.0.0 ships: comparing a v5 build against the v4
 * surface is not meaningful for classification, but it is better than not
 * running the checks at all, and the version rule reads a major bump correctly.
 *
 * The failure modes are deliberately not treated alike. "Never published" is a
 * legitimate skip: at bootstrap there is genuinely nothing to compare against.
 * A failed fetch is not, because a skip is indistinguishable from a pass in the
 * check's status, which would turn a registry blip into a silently ungated
 * release. So transient failures are retried and then reported as a failure,
 * and the job is re-runnable. Wedging a pull request for a few minutes is a
 * better trade than a gate that quietly stops gating.
 */
export function fetchPublished(outDir, { candidateVersion, spec, tag = COMPARE_TAG, name = 'reactfire', attempts = 3, backoffMs = 2000, run = execFileSync } = {}) {
  const dir = path.join(outDir, 'published');
  fs.mkdirSync(dir, { recursive: true });

  // Deliberately not defaulted. Falling back to `latest` when the caller forgets
  // to say what it is comparing reinstates exactly the bug `compareSpec` exists
  // to fix, and does it silently. A caller that genuinely wants the dist-tag
  // passes `spec` and says so.
  if (!spec && !candidateVersion) throw new TypeError('fetchPublished needs candidateVersion (or an explicit spec) to pick a comparison target');

  const primary = spec ?? compareSpec(candidateVersion);
  const opts = { name, attempts, backoffMs, run };
  const result = packPublished(dir, primary, opts);

  // Nothing on this major yet. The package itself is published, so this is the
  // new-major case rather than bootstrap; fall back rather than skip.
  if (result.unavailable?.reason === 'no-such-version' && primary !== tag) {
    const fallback = packPublished(dir, tag, opts);
    return fallback.version ? { ...fallback, fellBackFrom: primary } : fallback;
  }
  return result;
}

/**
 * Report why a comparison check could not run, and say whether it was allowed.
 * Returns true when the check should be treated as skipped rather than failed.
 */
export function reportUnavailable(check, published, report) {
  // A bare null (no published package at all) stays a skip.
  const info = published?.unavailable ?? { reason: 'not-published' };
  if (info.reason === 'not-published') {
    report.note(`${check}: no published release to compare against, skipped`);
    return true;
  }
  // Only reachable when the fallback dist-tag itself does not resolve, since a
  // major with no releases falls back to it. Still a skip rather than a failure:
  // there is no artifact to compare against, and none is being withheld.
  if (info.reason === 'no-such-version') {
    report.note(`${check}: nothing published matching ${info.spec}, skipped`);
    return true;
  }
  report.fail(
    check,
    `could not fetch the published release to compare against (${info.attempts} attempts)`,
    [
      info.detail ? `    ${info.detail}` : '',
      '    This is not a skip: without the published package the check cannot',
      '    run, and passing here would mean the gate silently stopped gating.',
      '    Re-run the job; if npm is down this will clear on its own.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return false;
}

/**
 * Fingerprint of a type surface: the file list and every file's contents.
 *
 * This is what `release-gate/accepted.json` records instead of a copy of the
 * `.d.ts` files themselves. It is enough to tell "the surface someone reviewed"
 * from "the surface being shipped now", which is all the acknowledgment needs to
 * do, and it keeps the committed artifact to one line.
 */
export function typesDigest(dir, files = listTypeFiles(dir)) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, file)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Parse "1.2.3" (ignoring any prerelease suffix) into [major, minor, patch]. */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether the candidate is a release being cut, rather than an ordinary build.
 *
 * Not a string comparison against the published version. CI stamps an
 * experimental version into package.json before packing (`4.2.6-exp.a0f4f4c`
 * for published 4.2.6), so `!==` treats every pull-request build as a release
 * candidate, and since the numeric core matches it then reads as a patch bump.
 * That would have failed the first pull request to legitimately change the type
 * surface, with a version error that had nothing to do with the change.
 *
 * Comparing the numeric core instead means a stamped build of the published
 * version is correctly seen as "not a release", while a genuine bump (4.2.7,
 * 4.3.0, and their prereleases) still is.
 */
export function isReleaseCandidate(candidate, published) {
  const a = parseVersion(candidate);
  const b = parseVersion(published);
  if (!a || !b) return false;
  return a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2];
}

/**
 * Whether `candidate` is more than a patch bump over `published`.
 *
 * Used only to decide whether a release is allowed to carry a type change.
 * Returns null when either version is unparseable, which the caller treats as
 * "cannot tell" rather than as a pass or a fail.
 */
export function isMinorOrMajorBump(candidate, published) {
  const a = parseVersion(candidate);
  const b = parseVersion(published);
  if (!a || !b) return null;
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

export function readAccepted(file = ACCEPTED_FILE) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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

/**
 * Diff the candidate's emitted `.d.ts` against the published release (#749).
 *
 * A difference is not by itself a failure: adding a hook legitimately changes
 * the type surface. What fails is a difference nobody acknowledged, so the
 * decision "is this additive or breaking, and what bump does it need" has to be
 * made by a person and shows up in review.
 */
export function checkTypes(pkgDir, pkg, published, report, { acceptedFile = ACCEPTED_FILE } = {}) {
  const distTypes = path.join(pkgDir, 'dist');
  const current = listTypeFiles(distTypes);

  if (!published?.version) {
    reportUnavailable('types', published, report);
    return;
  }

  const publishedTypes = path.join(published.pkgDir, 'dist');
  const baseline = listTypeFiles(publishedTypes);

  const added = current.filter((f) => !baseline.includes(f));
  const removed = baseline.filter((f) => !current.includes(f));
  const changed = [];
  for (const file of current.filter((f) => baseline.includes(f))) {
    const before = fs.readFileSync(path.join(publishedTypes, file), 'utf8');
    const after = fs.readFileSync(path.join(distTypes, file), 'utf8');
    if (before !== after) changed.push({ file, diff: diffLines(before, after) });
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    report.note(`types: identical to reactfire@${published.version}`);
    return;
  }

  const summary = `${changed.length} changed, ${added.length} added, ${removed.length} removed`;
  const digest = typesDigest(distTypes, current);
  const accepted = readAccepted(acceptedFile);
  const acknowledged = accepted?.types === digest && accepted?.against === published.version;

  if (!acknowledged) {
    const detail = [];
    if (removed.length > 0) detail.push(`    removed declaration file(s): ${removed.join(', ')}`);
    if (added.length > 0) detail.push(`    new declaration file(s): ${added.join(', ')}`);
    for (const { file, diff } of changed) {
      detail.push(`    --- dist/${file}`, diff);
    }
    // A digest recorded against an older release is the stale-acknowledgment
    // case: say so, because "run gate:accept" reads as a no-op otherwise.
    if (accepted && accepted.against !== published.version) {
      detail.push('', `    release-gate/accepted.json was taken against ${accepted.against}, but`, `    ${published.version} is now published. Retake it.`);
    }
    detail.push(
      '',
      '    The published type surface changed. Decide whether this is additive',
      '    (patch is fine) or non-additive (needs a minor or major bump plus a',
      '    changelog note), then run `npm run gate:accept` and commit',
      '    release-gate/accepted.json in the same pull request. See #749.',
    );
    report.fail('types', `emitted .d.ts differ from reactfire@${published.version} (${summary})`, detail.join('\n'));
    return;
  }

  report.note(`types: ${summary} vs reactfire@${published.version}, acknowledged in release-gate/accepted.json`);

  // Version rule. During normal development package.json carries the published
  // version (the bump is its own commit at release time, e.g. 7f93210 "4.2.6"),
  // so there is nothing to assert. Once it moves, this is a release candidate
  // and a changed type surface may not ship as a patch, which is exactly how
  // 4.2.4 broke consumer builds.
  if (!isReleaseCandidate(pkg.version, published.version)) return;
  const bumped = isMinorOrMajorBump(pkg.version, published.version);
  if (bumped === false) {
    report.fail(
      'types',
      `version ${pkg.version} is a patch bump over ${published.version}, but the type surface changed`,
      [
        '    A type change cannot ship as a patch: consumers on a caret range',
        '    pick it up unattended, which is what 4.2.4 did. Cut this as a minor',
        '    (or major, if it is breaking) and note it in the changelog.',
      ].join('\n'),
    );
  }
}

/** Measure the tarball and the declared entry points of one extracted package. */
export function measurePackage(pkgDir, pkg, tarball) {
  // `module` is written "./dist/index.js" and `main` "dist/index.umd.cjs";
  // normalize so keys line up between the candidate and the published package.
  const entries = [pkg.module, pkg.main].filter((rel) => typeof rel === 'string').map(normalizeRelative);
  const sizes = {};
  for (const rel of entries) {
    const file = path.join(pkgDir, rel);
    if (fs.existsSync(file)) sizes[rel] = measure(file);
  }
  return { packed: fs.statSync(tarball).size, sizes };
}

/**
 * Whether a recorded set of measurements still describes the current build,
 * within `SIZE_TOLERANCE`.
 *
 * Every entry must be present on both sides: an acknowledgment that predates a
 * new entry point should not silently cover it.
 */
export function sizesMatch(accepted, current) {
  if (!accepted || typeof accepted.packed !== 'number') return false;
  const within = (a, b) => b > 0 && Math.abs((a - b) / b) <= SIZE_TOLERANCE;
  if (!within(current.packed, accepted.packed)) return false;

  const acceptedKeys = Object.keys(accepted.sizes ?? {}).sort();
  const currentKeys = Object.keys(current.sizes ?? {}).sort();
  if (acceptedKeys.join() !== currentKeys.join()) return false;

  return currentKeys.every((key) => within(current.sizes[key].gzip, accepted.sizes[key].gzip));
}

export function checkSize(pkgDir, pkg, tarball, published, report, { acceptedFile = ACCEPTED_FILE, publishedMetrics } = {}) {
  const current = measurePackage(pkgDir, pkg, tarball);

  if (!published?.version) {
    // `types` already reported the reason; stay quiet rather than doubling it.
    if (published?.unavailable?.reason !== 'fetch-failed') report.note('size: no published release to compare against, skipped');
    return;
  }

  // `publishedMetrics` is a seam for the tests: measuring a real package cannot
  // hit a precise delta, and the tolerance value itself needs pinning.
  const before = publishedMetrics ?? measurePackage(published.pkgDir, readPackageJson(published.pkgDir), published.tarball);
  const accepted = readAccepted(acceptedFile);
  // Same acknowledgment as the type surface: an intended size move is recorded
  // once, against a named published version, and stops applying when that
  // version moves on.
  //
  // Matched within the tolerance rather than byte-exactly. `gate:accept` is run
  // locally, but the numbers it records get compared against a CI build, and the
  // two are never byte-identical: CI stamps an experimental version into the
  // bundle before packing (4.2.6-exp.<sha>), which measured ~+0.5% on the
  // tarball. Exact matching would mean no acknowledgment ever applied in CI, so
  // an intended size change could not be landed at all.
  const acknowledged = accepted?.against === published.version && sizesMatch(accepted?.size, current);

  const over = [];

  // Guards the whole tarball, not just the entry points. `files` includes
  // `src`, so anything that lands under src/ ships to npm, including a nested
  // node_modules if one is ever present at pack time.
  const packedDelta = (current.packed - before.packed) / before.packed;
  const packedPct = `${packedDelta >= 0 ? '+' : ''}${(packedDelta * 100).toFixed(1)}%`;
  report.note(`tarball: ${current.packed} B (${packedPct} vs ${published.version} ${before.packed} B)`);
  if (Math.abs(packedDelta) > SIZE_TOLERANCE) {
    over.push({
      message: `packed tarball size moved ${packedPct} (${before.packed} B -> ${current.packed} B), tolerance is ±${SIZE_TOLERANCE * 100}%`,
      detail: '    Check what the `files` allowlist is picking up (`npm pack --dry-run`).',
    });
  }

  for (const [rel, now] of Object.entries(current.sizes)) {
    const was = before.sizes[rel];
    if (!was) {
      // A new entry point has nothing to compare against, which is a packaging
      // change worth seeing but not a size regression.
      report.note(`${rel}: ${now.gzip} B gzip (new entry, not in ${published.version})`);
      continue;
    }
    const delta = (now.gzip - was.gzip) / was.gzip;
    const pct = `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
    report.note(`${rel}: ${now.gzip} B gzip (${pct} vs ${published.version} ${was.gzip} B)`);
    if (Math.abs(delta) > SIZE_TOLERANCE) {
      over.push({
        message: `${rel} gzip size moved ${pct} (${was.gzip} B -> ${now.gzip} B), tolerance is ±${SIZE_TOLERANCE * 100}%`,
        detail: '    A jump usually means a dependency got inlined; a drop usually means\n    something stopped being bundled.',
      });
    }
  }

  if (over.length === 0) return;
  if (acknowledged) {
    report.note(`size: ${over.length} entr(y/ies) outside tolerance, acknowledged in release-gate/accepted.json`);
    return;
  }
  for (const { message, detail } of over) {
    report.fail('size', message, [detail, '    If the change is intended, run `npm run gate:accept` and commit', '    release-gate/accepted.json.'].join('\n'));
  }
}

/** Run every read-only check against an extracted package directory. */
export function runChecks(pkgDir, pkg, tarball, published, options = {}) {
  const report = createReport();
  checkNoCjsInEsm(pkgDir, pkg, report);
  checkExternals(pkgDir, pkg, report);
  checkExportsMap(pkgDir, pkg, report);
  checkTypes(pkgDir, pkg, published, report, options);
  checkSize(pkgDir, pkg, tarball, published, report, options);
  return report;
}

/**
 * Record an acknowledgment of the current build's type surface and sizes.
 *
 * Scoped to the published version it was taken against, so it expires on the
 * next release rather than silently carrying forward.
 */
export function writeAccepted(pkgDir, pkg, tarball, published, file = ACCEPTED_FILE) {
  const body = {
    against: published.version,
    types: typesDigest(path.join(pkgDir, 'dist')),
    size: measurePackage(pkgDir, pkg, tarball),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return body;
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
  // Acknowledging an arbitrary tarball would silently bless whatever that build
  // contained, including a regression.
  if (accept && tarballArg) {
    console.error('--accept acknowledges the current build and takes no tarball argument.');
    console.error('Build first (`npx tsc && npx vite build`), then run `npm run gate:accept`.');
    return 2;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reactfire-gate-'));
  try {
    const tarball = tarballArg ? path.resolve(tarballArg) : pack(tmp);
    const pkgDir = extract(tarball, tmp);
    const pkg = readPackageJson(pkgDir);
    const published = fetchPublished(tmp, { candidateVersion: pkg.version });

    console.log(`release gate: reactfire@${pkg.version} (${path.basename(tarball)})`);
    console.log(
      published.version
        ? `comparing against reactfire@${published.version} (npm ${published.spec})${published.fellBackFrom ? `, nothing published matching ${published.fellBackFrom}` : ''}\n`
        : `no published release available (${published.unavailable.reason})\n`,
    );

    if (accept) {
      if (!published.version) {
        console.error(`nothing to acknowledge against: ${published.unavailable.reason}.`);
        if (published.unavailable.detail) console.error(`  ${published.unavailable.detail}`);
        return 2;
      }
      const body = writeAccepted(pkgDir, pkg, tarball, published);
      console.log(`acknowledged against reactfire@${body.against}.`);
      console.log('Review release-gate/accepted.json and commit it with the change it covers.');
      return 0;
    }

    const { failures, notes } = runChecks(pkgDir, pkg, tarball, published);

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
