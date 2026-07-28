import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_REACT_VERSIONS,
  EXPECTED_EXPORTS,
  FIREBASE_RANGE,
  collectFailures,
  describeResult,
  fixtureManifest,
  loadWithReact,
  parseProbeOutput,
  probeSource,
} from '../scripts/entry-load.mjs';

/**
 * The entry-load test exists because `exports-map` can only see that a file is
 * present, not that it runs. Verified against the published tarballs: 4.2.4 and
 * 4.2.5 throw on the ESM entry while their CJS entry loads, and 4.2.6 loads on
 * both. These tests pin the orchestration and the result handling so the check
 * cannot quietly degrade into always passing.
 */

describe('fixtureManifest', () => {
  it('pins the requested React major to react and react-dom', () => {
    const manifest = fixtureManifest({ react: '19' });
    expect(manifest.dependencies.react).toBe('^19');
    expect(manifest.dependencies['react-dom']).toBe('^19');
  });

  it('holds firebase to the range the repo develops against', () => {
    expect(fixtureManifest({ react: '18' }).dependencies.firebase).toBe(FIREBASE_RANGE);
  });

  // Both probes live in one fixture, so it must not declare a module type;
  // each probe carries its own extension instead.
  it('does not declare a module type', () => {
    expect(fixtureManifest({ react: '18' }).type).toBeUndefined();
  });
});

describe('probeSource', () => {
  it('imports for esm and requires for cjs', () => {
    expect(probeSource('esm')).toContain('import("reactfire")');
    expect(probeSource('cjs')).toContain('require("reactfire")');
  });

  it('checks the expected exports are present', () => {
    const source = probeSource('esm');
    for (const name of EXPECTED_EXPORTS) expect(source).toContain(name);
  });

  it('reports a throw rather than letting the probe die silently', () => {
    expect(probeSource('esm')).toContain("reason: 'threw'");
    expect(probeSource('cjs')).toContain("reason: 'threw'");
  });
});

describe('parseProbeOutput', () => {
  it('reads the JSON line a probe prints', () => {
    expect(parseProbeOutput('{"ok":true,"exports":74}')).toEqual({ ok: true, exports: 74 });
  });

  // npm and node both like to print warnings ahead of real output.
  it('takes the last line when something printed first', () => {
    expect(parseProbeOutput('some warning\n{"ok":true,"exports":74}\n')).toEqual({ ok: true, exports: 74 });
  });

  it('treats no output as a failure', () => {
    expect(parseProbeOutput('').ok).toBe(false);
    expect(parseProbeOutput('   \n  ').reason).toBe('no-output');
  });

  it('treats unparseable output as a failure rather than throwing', () => {
    const result = parseProbeOutput('Segmentation fault');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unparseable-output');
  });
});

describe('describeResult', () => {
  it('describes each failure shape', () => {
    expect(describeResult({ ok: true, exports: 74 })).toContain('74');
    expect(describeResult({ ok: false, reason: 'threw', message: 'boom' })).toContain('boom');
    expect(describeResult({ ok: false, reason: 'missing-exports', missing: ['useUser'] })).toContain('useUser');
    expect(describeResult({ ok: false, reason: 'no-output' })).toContain('no output');
    expect(describeResult({ ok: false, reason: 'crashed', code: 139, message: 'sig' })).toContain('139');
  });
});

describe('collectFailures', () => {
  it('is empty when every entry loaded', () => {
    expect(collectFailures([{ react: '18', esm: { ok: true }, cjs: { ok: true } }])).toEqual([]);
  });

  // The 4.2.5 shape: the ESM entry throws while the CJS entry is fine. A check
  // that only looked at one of them would have missed the shipped regression.
  it('reports an esm-only failure', () => {
    const failures = collectFailures([{ react: '18', esm: { ok: false, reason: 'threw', message: 'require' }, cjs: { ok: true } }]);
    expect(failures).toHaveLength(1);
    expect(failures[0].entry).toBe('esm');
  });

  // The mirror of the case above. Without this, dropping the CJS branch
  // entirely left every test green: the check would silently have become
  // ESM-only, and a UMD-side break would ship.
  it('reports a cjs-only failure', () => {
    const failures = collectFailures([{ react: '18', esm: { ok: true }, cjs: { ok: false, reason: 'threw', message: 'bad' } }]);
    expect(failures).toHaveLength(1);
    expect(failures[0].entry).toBe('cjs');
  });

  it('reports both entries when both fail', () => {
    const failures = collectFailures([{ react: '18', esm: { ok: false, reason: 'threw', message: 'a' }, cjs: { ok: false, reason: 'threw', message: 'b' } }]);
    expect(failures.map((f) => f.entry).sort()).toEqual(['cjs', 'esm']);
  });

  it('reports failures per React version', () => {
    const failures = collectFailures([
      { react: '18', esm: { ok: true }, cjs: { ok: true } },
      { react: '19', esm: { ok: false, reason: 'threw', message: 'x' }, cjs: { ok: true } },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].react).toBe('19');
  });
});

describe('loadWithReact', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-load-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Stand in for npm and node without installing or running anything. */
  const runner = ({ esm = '{"ok":true,"exports":74}', cjs = '{"ok":true,"exports":74}', onNode } = {}) => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'npm') return '';
      if (onNode) return onNode(args);
      return String(args[0]).endsWith('.mjs') ? esm : cjs;
    };
    return { run, calls };
  };

  it('writes a fixture with both probes and a manifest', () => {
    const { run } = runner();
    loadWithReact('/tmp/reactfire.tgz', '18', { run, root: dir });
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'probe.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'probe.cjs'))).toBe(true);
  });

  // Installing the tarball first would resolve its peers against an empty tree.
  it('installs the peers before the package under test', () => {
    const { run, calls } = runner();
    loadWithReact('/tmp/reactfire.tgz', '18', { run, root: dir });
    const installs = calls.filter((c) => c.cmd === 'npm');
    expect(installs).toHaveLength(2);
    expect(installs[0].args.some((a) => a.endsWith('.tgz'))).toBe(false);
    expect(installs[1].args.some((a) => a.endsWith('.tgz'))).toBe(true);
  });

  it('passes the tarball as an absolute path', () => {
    const { run, calls } = runner();
    loadWithReact('./reactfire.tgz', '18', { run, root: dir });
    const install = calls.filter((c) => c.cmd === 'npm')[1];
    expect(install.args.some((a) => path.isAbsolute(a) && a.endsWith('.tgz'))).toBe(true);
  });

  it('reports both entry points', () => {
    const { run } = runner();
    const result = loadWithReact('/tmp/reactfire.tgz', '18', { run, root: dir });
    expect(result.esm.ok).toBe(true);
    expect(result.cjs.ok).toBe(true);
  });

  it('surfaces a throwing ESM entry, the 4.2.5 shape', () => {
    const { run } = runner({ esm: '{"ok":false,"reason":"threw","message":"Calling `require` for \\"react\\""}' });
    const result = loadWithReact('/tmp/reactfire.tgz', '18', { run, root: dir });
    expect(result.esm.ok).toBe(false);
    expect(result.cjs.ok).toBe(true);
    expect(describeResult(result.esm)).toContain('require');
  });

  // A probe that dies without printing must not read as a pass.
  it('treats a probe that exits without output as a failure', () => {
    const onNode = () => {
      const error = new Error('killed');
      error.status = 139;
      error.stderr = 'Segmentation fault';
      throw error;
    };
    const { run } = runner({ onNode });
    const result = loadWithReact('/tmp/reactfire.tgz', '18', { run, root: dir });
    expect(result.esm.ok).toBe(false);
    expect(result.esm.reason).toBe('crashed');
    expect(result.esm.code).toBe(139);
  });

  it('fails a package that loads but is missing exports', () => {
    const { run } = runner({ esm: '{"ok":false,"reason":"missing-exports","missing":["useUser"]}' });
    const result = loadWithReact('/tmp/reactfire.tgz', '18', { run, root: dir });
    expect(collectFailures([{ react: '18', ...result }])).toHaveLength(1);
  });
});

describe('defaults', () => {
  // Mirrors the matrix CI already type-checks, so a React-major-specific break
  // is visible in both places.
  it('tests the React majors CI type-checks', () => {
    expect(DEFAULT_REACT_VERSIONS).toEqual(['18', '19']);
  });

  it('expects exports from more than one submodule', () => {
    expect(EXPECTED_EXPORTS.length).toBeGreaterThan(1);
  });
});
