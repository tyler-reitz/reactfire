import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compare } from '../scripts/api-diff/api-diff.mjs';
import { decide } from '../scripts/api-diff/check.mjs';
import { stripPrivateMembers } from '../scripts/api-diff/strip-private.mjs';

/**
 * Tests for the API differ (scripts/api-diff).
 *
 * The differ classifies a `.d.ts` change as breaking, additive, or no change,
 * which is the half of #749 the release gate currently hands to a human.
 *
 * Fixtures live in test/fixtures/api-diff/<case>/{old,new}. **Every one ends
 * with `export {};` on purpose.** Without it a `.d.ts` treats its unexported
 * top-level types as module exports, so a hand-written fixture silently models
 * something the compiler would never emit. tsc appends `export {}` for exactly
 * this reason. The "fixture sanity" test at the bottom guards it.
 */

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/api-diff');

// Each `run` builds three TypeScript programs, so the default 5s is too tight.
const TIMEOUT = 30_000;

let workspace;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'api-diff-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/**
 * Copy a fixture pair into the workspace, strip private members, compare.
 *
 * Copied rather than used in place because `compare` writes a probe file into
 * the new directory, and because stripping rewrites the sources.
 */
function run(name, { strip = true } = {}) {
  const dirs = {};
  for (const side of ['old', 'new']) {
    const dest = path.join(workspace, name, side);
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(path.join(FIXTURES, name, side))) {
      const source = fs.readFileSync(path.join(FIXTURES, name, side, file), 'utf8');
      fs.writeFileSync(path.join(dest, file), strip ? stripPrivateMembers(source, file) : source);
    }
    dirs[side] = dest;
  }
  return compare(dirs.old, dirs.new);
}

describe('verdicts', () => {
  // The single most valuable control: a version compared against itself must be
  // a no-op. It is what caught the nominal-typing bug, where classes with
  // private members made the package report as breaking against itself.
  it(
    'reports no change for identical input',
    () => {
      const result = run('unchanged');
      expect(result.verdict).toBe('NO CHANGE');
      expect(result.roots).toEqual([]);
      expect(result.breakingCount).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'reports breaking when a returned value widens',
    () => {
      const result = run('breaking-widen');
      expect(result.verdict).toBe('BREAKING');
      expect(result.roots).toContain('Status');
    },
    TIMEOUT,
  );

  // The StorageImage case: a parameter accepting more cannot break an existing
  // call, so it is additive even though old is no longer assignable to new.
  it(
    'reports a widened parameter as additive, not breaking',
    () => {
      const result = run('permissive-widen');
      expect(result.verdict).toBe('ADDITIVE');
      expect(result.permissive).toContain('render');
      expect(result.roots).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'reports a removed export as breaking',
    () => {
      const result = run('removed');
      expect(result.verdict).toBe('BREAKING');
      expect(result.removed).toEqual(['drop']);
    },
    TIMEOUT,
  );

  it(
    'reports a new export as additive',
    () => {
      const result = run('added');
      expect(result.verdict).toBe('ADDITIVE');
      expect(result.added).toEqual(['extra']);
      expect(result.breakingCount).toBe(0);
    },
    TIMEOUT,
  );
});

describe('root-cause attribution', () => {
  // The useInitAuth shape: three exports break, but each reaches Status through
  // a non-exported local alias. Following only exported names reported all four
  // as peers, which buries the one decision there is to make.
  it(
    'collapses a cascade to the single symbol that changed',
    () => {
      const result = run('cascade');
      expect(result.roots).toEqual(['Status']);
      expect(result.derived.map((d) => d.name).sort()).toEqual(['useA', 'useB', 'useC']);
      for (const entry of result.derived) expect(entry.via).toContain('Status');
    },
    TIMEOUT,
  );

  // Mutual recursion leaves no symbol that fails independently. Reporting
  // nothing would be worse than reporting the group.
  it(
    'reports the whole group when every failure is part of a cycle',
    () => {
      const result = run('cyclic');
      expect(result.verdict).toBe('BREAKING');
      expect(result.cyclic).toBe(true);
      expect(result.roots.sort()).toEqual(['A', 'B']);
    },
    TIMEOUT,
  );
});

describe('generic constraints', () => {
  // Synthesising a bare type parameter does not satisfy `T extends string`, so
  // an identical copy reported as breaking. Instantiating with any/unknown
  // fixes that but makes the comparison trivially pass, which is worse.
  it(
    'does not false-positive on an unchanged constrained generic',
    () => {
      expect(run('constrained-ok').verdict).toBe('NO CHANGE');
    },
    TIMEOUT,
  );

  it(
    'still detects a real break behind a constraint',
    () => {
      const result = run('constrained-break');
      expect(result.verdict).toBe('BREAKING');
      expect(result.roots).toContain('Box');
    },
    TIMEOUT,
  );
});

describe('nominal types', () => {
  // TypeScript types a class with private members nominally, so two copies are
  // never assignable. Without stripping, this fixture compares as breaking
  // against an identical copy of itself.
  it(
    'reports no change once private members are stripped',
    () => {
      const result = run('nominal');
      expect(result.verdict).toBe('NO CHANGE');
    },
    TIMEOUT,
  );

  it(
    'reports a false break if they are not stripped',
    () => {
      const result = run('nominal', { strip: false });
      expect(result.verdict).toBe('BREAKING');
    },
    TIMEOUT,
  );
});

describe('stripPrivateMembers', () => {
  const CLASS = `export declare class Handler {
    private callback: (
        event: string,
        payload: number
    ) => void;
    protected mode: string;
    #secret: string;
    /** kept */
    run(): void;
}
`;

  it('removes private, protected, and #private members', () => {
    const out = stripPrivateMembers(CLASS);
    expect(out).not.toContain('callback');
    expect(out).not.toContain('mode');
    expect(out).not.toContain('#secret');
  });

  it('keeps public members and their comments', () => {
    const out = stripPrivateMembers(CLASS);
    expect(out).toContain('run(): void;');
    expect(out).toContain('/** kept */');
  });

  // A line regex deletes only the first line of a multi-line member and leaves
  // the rest as garbage, so the file stops parsing and the comparison becomes
  // meaningless without failing.
  it('removes a multi-line member whole, leaving something that still parses', () => {
    const out = stripPrivateMembers(CLASS);
    expect(out).not.toContain('payload: number');
    expect(out).not.toContain('=> void;');
  });

  it('leaves a class with no hidden members untouched', () => {
    const source = 'export declare class C {\n    run(): void;\n}\n';
    expect(stripPrivateMembers(source)).toBe(source);
  });
});

describe('fixture sanity', () => {
  // Guards the trap directly: without the trailing `export {};` a .d.ts treats
  // its unexported top-level types as exports. `Hook` in the cascade fixture is
  // a local alias and must stay local, or that fixture is quietly testing a
  // different shape than the one it documents.
  it(
    'does not leak local types as exports',
    () => {
      const result = run('cascade');
      expect(result.exportNames.new).not.toContain('Hook');
      expect(result.exportNames.new).toContain('Status');
    },
    TIMEOUT,
  );
});

describe('decide', () => {
  const at = (over) => decide({ candidateVersion: '4.2.6', publishedVersion: '4.2.6', base: 'main', ...over });

  // On a pull request package.json still carries the published version, so the
  // question is where the change is going, not what it is versioned as.
  describe('on a pull request', () => {
    // This is 4.2.4: a breaking type change landing on the v4 line.
    it('rejects a breaking change targeting main', () => {
      const decision = at({ verdict: 'BREAKING' });
      expect(decision.ok).toBe(false);
      expect(decision.reason).toContain('cannot target main');
    });

    // On v5 a breaking type change is the entire point.
    it('allows a breaking change targeting v5', () => {
      expect(at({ verdict: 'BREAKING', base: 'v5' }).ok).toBe(true);
    });

    it('allows additive and unchanged surfaces anywhere', () => {
      expect(at({ verdict: 'ADDITIVE' }).ok).toBe(true);
      expect(at({ verdict: 'NO CHANGE' }).ok).toBe(true);
      expect(at({ verdict: 'ADDITIVE', base: 'v5' }).ok).toBe(true);
    });
  });

  // Once package.json's numeric version moves off the published one this is a
  // release, and semver applies whatever branch it is on.
  describe('on a release', () => {
    it('requires a major for a breaking surface', () => {
      expect(at({ verdict: 'BREAKING', candidateVersion: '4.3.0' }).ok).toBe(false);
      expect(at({ verdict: 'BREAKING', candidateVersion: '5.0.0' }).ok).toBe(true);
    });

    // The 4.2.4 mistake stated precisely: a changed surface cut as a patch.
    it('requires at least a minor for an additive surface', () => {
      expect(at({ verdict: 'ADDITIVE', candidateVersion: '4.2.7' }).ok).toBe(false);
      expect(at({ verdict: 'ADDITIVE', candidateVersion: '4.3.0' }).ok).toBe(true);
    });

    it('allows a patch when nothing changed', () => {
      expect(at({ verdict: 'NO CHANGE', candidateVersion: '4.2.7' }).ok).toBe(true);
    });

    // The branch carve-out must not leak into releases: cutting a breaking
    // release off v5 as a minor is still wrong.
    it('does not let the branch exempt a release', () => {
      expect(at({ verdict: 'BREAKING', candidateVersion: '4.3.0', base: 'v5' }).ok).toBe(false);
    });
  });
});
