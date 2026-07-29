#!/usr/bin/env node
/**
 * Semver check on the published type surface (#749).
 *
 * Runs as its own CI job, **Check API compatibility**. Separate from the
 * release gate because it needs `typescript` installed, and keeping it out is
 * what lets the gate stay dependency-free.
 *
 * The gate's `types` check answers "did anything change" and asks a human to
 * classify it. This answers "is the change breaking", so the classification
 * stops being a judgement call. See ./README.md for how the verdict is reached.
 *
 * Usage:
 *   node scripts/api-diff/check.mjs <tarball> [--base <branch>]
 *
 * ## Policy
 *
 * What is allowed depends on where the change is going, which mirrors how the
 * repo actually branches: v4 patches and minors land on `main`, breaking work
 * lands on `v5`.
 *
 *   BREAKING targeting `main`   fail. This is the 4.2.4 case exactly.
 *   BREAKING targeting anything else   report and pass; on `v5` that is the point.
 *   ADDITIVE or NO CHANGE   report and pass.
 *
 * On a release commit (package.json's numeric version has moved off the
 * published one) the semver rule is enforced regardless of branch: a breaking
 * surface needs a major, a changed one needs at least a minor.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchPublished, isMinorOrMajorBump, isReleaseCandidate, parseVersion } from '../release-gate.mjs';
import { compare } from './api-diff.mjs';
import { stripPrivateMembers } from './strip-private.mjs';

/** Branches where a breaking type change is a defect rather than the intent. */
export const STABLE_BRANCHES = ['main'];

function extract(tarball, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', outDir]);
  return path.join(outDir, 'package', 'dist');
}

/** Rewrite every .d.ts in place with private and protected members removed. */
function stripTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) stripTree(target);
    else if (entry.name.endsWith('.d.ts')) fs.writeFileSync(target, stripPrivateMembers(fs.readFileSync(target, 'utf8'), target));
  }
}

/**
 * Turn a verdict into a pass or fail.
 *
 * Split out from the IO so the policy is testable on its own, since it is the
 * part that decides whether CI goes red.
 */
export function decide({ verdict, base, candidateVersion, publishedVersion }) {
  const release = isReleaseCandidate(candidateVersion, publishedVersion);

  if (release) {
    const bumped = isMinorOrMajorBump(candidateVersion, publishedVersion);
    const major = parseVersion(candidateVersion)?.[0] > parseVersion(publishedVersion)?.[0];
    if (verdict === 'BREAKING' && !major) {
      return { ok: false, reason: `a breaking type change needs a major bump, but ${publishedVersion} -> ${candidateVersion} is not one` };
    }
    if (verdict === 'ADDITIVE' && bumped === false) {
      return { ok: false, reason: `the type surface grew, so ${publishedVersion} -> ${candidateVersion} needs at least a minor bump` };
    }
    return { ok: true, reason: `release ${candidateVersion} is consistent with a ${verdict.toLowerCase()} type surface` };
  }

  if (verdict === 'BREAKING' && STABLE_BRANCHES.includes(base)) {
    return {
      ok: false,
      reason: `breaking type changes cannot target ${base}; retarget at v5, or make the change backwards compatible`,
    };
  }
  if (verdict === 'BREAKING') {
    return { ok: true, reason: `breaking, but targeting ${base || '(unknown branch)'} rather than ${STABLE_BRANCHES.join('/')}` };
  }
  return { ok: true, reason: verdict === 'ADDITIVE' ? 'additive; needs a minor when released' : 'the published type surface is unchanged' };
}

function main() {
  const args = process.argv.slice(2);
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : '';
  const tarball = args.find((a) => !a.startsWith('--') && a !== base);

  if (!tarball || !fs.existsSync(tarball)) {
    console.error('usage: node scripts/api-diff/check.mjs <tarball> [--base <branch>]');
    return 2;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-diff-'));
  try {
    // Extracted before fetching, because which published release to compare
    // against is derived from the candidate's own major. Comparing a v4 build
    // against whatever holds the `latest` dist-tag breaks the entire v4 line
    // once 5.0.0 takes it; see `compareSpec` in the release gate.
    const newDist = extract(tarball, path.join(tmp, 'candidate'));
    const candidateVersion = JSON.parse(fs.readFileSync(path.join(newDist, '..', 'package.json'), 'utf8')).version;

    const published = fetchPublished(tmp, { candidateVersion });
    if (!published.version) {
      const { reason } = published.unavailable;
      if (reason === 'not-published' || reason === 'no-such-version') {
        console.log('no published release to compare against, skipped');
        return 0;
      }
      // Same reasoning as the release gate: a skip is indistinguishable from a
      // pass, so a registry failure must not quietly stop the check running.
      console.error(`could not fetch the published release (${published.unavailable.attempts} attempts)`);
      console.error(`  ${published.unavailable.detail ?? ''}`);
      console.error('  Re-run the job; if npm is down this clears on its own.');
      return 1;
    }

    const oldDist = path.join(published.pkgDir, 'dist');
    stripTree(newDist);
    stripTree(oldDist);

    const result = compare(oldDist, newDist);

    console.log(`api diff: reactfire@${candidateVersion} vs published ${published.version} (npm ${published.spec})`);
    if (base) console.log(`target branch: ${base}`);
    console.log(`\nverdict: ${result.verdict}`);
    if (result.removed.length) console.log(`  removed exports: ${result.removed.join(', ')}`);
    if (result.added.length) console.log(`  added exports: ${result.added.join(', ')}`);
    if (result.permissive.length) console.log(`  more permissive (existing code still compiles): ${result.permissive.join(', ')}`);
    if (result.roots.length) {
      console.log(`  breaking, ${result.roots.length} root cause(s)${result.cyclic ? ' (cyclic)' : ''}:`);
      for (const name of result.roots) console.log(`    * ${name}`);
      if (result.derived.length) console.log(`  ${result.derived.length} further symbol(s) break as a consequence`);
    }

    const decision = decide({ verdict: result.verdict, base, candidateVersion, publishedVersion: published.version });
    console.log(`\n${decision.ok ? 'ok' : 'FAILED'}: ${decision.reason}`);
    if (!decision.ok && result.derived.length) {
      console.error('\n  Consequential breaks, for context:');
      for (const { name, via } of result.derived.slice(0, 10)) console.error(`    - ${name} via ${via.join(', ')}`);
    }
    return decision.ok ? 0 : 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
