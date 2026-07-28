/**
 * PROTOTYPE: classify a .d.ts change as additive or breaking.
 *
 * Not wired into anything. See README.md for the approach, what it has been
 * validated against, and what would have to happen before it could ship.
 *
 * Two ideas carry the whole thing:
 *
 * 1. Let tsc decide. For every symbol exported by both versions, emit probe
 *    lines asserting assignability in each direction, compile, read the errors.
 *    Only `new -> old` failing is a consumer break; the other direction alone
 *    means the API became more permissive.
 *
 * 2. Collapse the cascade. One root change flags everything that mentions it:
 *    the ObservableStatus union made 32 exports fail when there was a single
 *    decision to make. A failing symbol is a ROOT only if it does not reference
 *    another failing one, so the rest are reported as consequences.
 */

import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';

// Two extracted package directories to compare, each containing dist/index.d.ts.
// Run strip-private.mjs over both first; see README.md.
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const WORK = path.resolve(arg('--work', process.cwd()));
const OLD = path.resolve(arg('--old', path.join(WORK, 'old/package/dist')), 'index.d.ts');
const NEW = path.resolve(arg('--new', path.join(WORK, 'new/package/dist')), 'index.d.ts');

const COMPILER_OPTIONS = {
  strict: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
  baseUrl: WORK,
};

/** Follow import/export aliases to the symbol that actually declares something. */
function resolveAlias(checker, symbol) {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function readExports(entry) {
  const program = ts.createProgram([entry], COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const symbols = checker.getExportsOfModule(moduleSymbol);
  // Identity, not name. Two files can each declare a local type called
  // `Helper`, and a name-keyed map would follow the wrong one and mis-attribute
  // the root cause. The checker resolves each identifier to the symbol it
  // actually refers to, which removes the collision entirely.
  const exportSymbols = new Set(symbols.map((s) => resolveAlias(checker, s)));

  /**
   * Exported symbols reachable from a declaration, walking through local types.
   *
   * The graph has to see non-exported types. `useInitAuth` is declared as
   * `InitSdkHook<Auth>`, and `InitSdkHook` is a local alias returning
   * `ObservableStatus<Sdk>`. Stopping at exported names made `useInitAuth` look
   * like an independent root when its declaration is byte-identical across
   * versions and the only thing that changed was ObservableStatus.
   */
  const reachableExports = (startDecls, self) => {
    const found = new Set();
    const seen = new Set();
    const walk = (node) => {
      if (ts.isIdentifier(node)) {
        const symbol = resolveAlias(checker, checker.getSymbolAtLocation(node));
        if (symbol && !seen.has(symbol)) {
          if (exportSymbols.has(symbol)) {
            // An exported symbol is where attribution stops: if it changed too,
            // it is the thing to report, and its dependencies are its story.
            if (symbol.getName() !== self) found.add(symbol.getName());
            return;
          }
          // A local type: keep going, its contents are part of this symbol.
          const decls = (symbol.declarations ?? []).filter((d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isClassDeclaration(d));
          if (decls.length > 0) {
            seen.add(symbol);
            for (const decl of decls) walk(decl);
            return;
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    for (const decl of startDecls) walk(decl);
    return found;
  };

  const out = new Map();
  for (const symbol of symbols) {
    const name = symbol.getName();
    const flags = symbol.flags;
    const decls = symbol.declarations ?? [];

    // Copy the type parameters verbatim, minus defaults. A default is not
    // valid on the probe's own arrow function, and dropping it is safe: the
    // probe always passes explicit arguments.
    let typeParams = '';
    let args = '';
    for (const decl of decls) {
      if (!decl.typeParameters?.length) continue;
      const file = decl.getSourceFile();
      typeParams = decl.typeParameters
        .map((tp) => {
          const paramName = tp.name.text;
          return tp.constraint ? `${paramName} extends ${tp.constraint.getText(file)}` : paramName;
        })
        .join(', ');
      args = `<${decl.typeParameters.map((tp) => tp.name.text).join(', ')}>`;
      break;
    }

    out.set(name, {
      name,
      typeParams,
      args,
      refs: reachableExports(decls, name),
      isValue: Boolean(flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Enum)),
      isType: Boolean(flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Class | ts.SymbolFlags.Enum)),
    });
  }
  return { exports: out, program };
}

/**
 * Import statements from every declaration file in the package.
 *
 * A constrained generic's constraint can name anything its own file imported
 * (`Sdk extends FirebaseSdks`, `T extends DocumentData`). The probe has to be
 * able to say those names, so it inherits the package's imports and is written
 * into the package's own dist directory, where the relative ones resolve.
 */
function collectImportLines(program, dir) {
  const seen = new Set();
  const lines = [];
  for (const file of program.getSourceFiles()) {
    if (!path.resolve(file.fileName).startsWith(path.resolve(dir))) continue;
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const text = statement.getText(file);
      // Dedupe on the whole statement; a genuine alias collision across files
      // would surface as a compile error in the probe rather than silently.
      if (seen.has(text)) continue;
      seen.add(text);
      lines.push(text);
    }
  }
  return lines;
}

/**
 * Probe lines, one per (symbol, direction).
 *
 * Type parameters are copied from the declaration verbatim rather than
 * synthesised as bare `<A0,>`. A synthesised parameter does not satisfy a
 * constraint, so `interface Box<T extends string>` compared against an
 * identical copy of itself reported BREAKING. Instantiating with `any` or
 * `unknown` avoids that but makes the comparison trivially pass, which is
 * worse: it hid the ObservableStatus break entirely.
 */
function buildProbe(shared, importLines, oldEntry) {
  const lines = [...importLines, `import * as O from ${JSON.stringify(oldEntry)};`, `import * as N from './index';`, ''];
  const index = new Map();
  const emit = (text, entry) => {
    lines.push(text);
    index.set(lines.length, entry);
  };
  for (const info of shared) {
    const { name, typeParams, args } = info;
    const generics = typeParams ? `<${typeParams},>` : '';
    if (info.isType) {
      emit(`const __t_o2n_${name} = ${generics}(v: O.${name}${args}): N.${name}${args} => v;`, { name, direction: 'old->new' });
      emit(`const __t_n2o_${name} = ${generics}(v: N.${name}${args}): O.${name}${args} => v;`, { name, direction: 'new->old' });
    }
    if (info.isValue) {
      emit(`const __v_o2n_${name}: typeof N.${name} = O.${name};`, { name, direction: 'old->new' });
      emit(`const __v_n2o_${name}: typeof O.${name} = N.${name};`, { name, direction: 'new->old' });
    }
  }
  return { source: lines.join('\n') + '\n', index };
}

/**
 * Split failures into roots and derived.
 *
 * A failure is derived if its declaration mentions another failing export, and
 * transitively so: the attribution walks down to something that fails on its
 * own account. Cycles would otherwise leave no roots at all, so any group with
 * no independent member is reported whole.
 */
function attribute(failures, exports) {
  const failed = new Set(failures.keys());
  const roots = [];
  const derived = [];

  for (const name of failed) {
    const refs = exports.get(name)?.refs ?? new Set();
    const failingRefs = [...refs].filter((r) => failed.has(r));
    if (failingRefs.length === 0) roots.push(name);
    else derived.push({ name, via: failingRefs });
  }

  // Every failure participates in a cycle: nothing is independent, so there is
  // no meaningful root to report and the whole set is the finding.
  if (roots.length === 0 && failed.size > 0) return { roots: [...failed], derived: [], cyclic: true };
  return { roots, derived, cyclic: false };
}

function main() {
  const { exports: oldExports } = readExports(OLD);
  const { exports: newExports, program: newProgram } = readExports(NEW);
  const removed = [...oldExports.keys()].filter((k) => !newExports.has(k));
  const added = [...newExports.keys()].filter((k) => !oldExports.has(k));
  const shared = [...newExports.values()].filter((e) => oldExports.has(e.name));

  // The probe lives in the package's own dist so the inherited relative
  // imports resolve, and so external packages resolve up the node_modules
  // chain the same way the declarations themselves do.
  const newDist = path.dirname(NEW);
  const importLines = collectImportLines(newProgram, newDist);
  const { source, index } = buildProbe(shared, importLines, OLD.replace(/\.d\.ts$/, ''));
  const probePath = path.join(newDist, '__probe.ts');
  fs.writeFileSync(probePath, source);

  const program = ts.createProgram([probePath], COMPILER_OPTIONS);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file && path.resolve(d.file.fileName) === probePath);

  const failures = new Map();
  for (const d of diagnostics) {
    const line = d.file.getLineAndCharacterOfPosition(d.start).line + 1;
    const entry = index.get(line);
    if (!entry) continue;
    if (!failures.has(entry.name)) failures.set(entry.name, new Set());
    failures.get(entry.name).add(entry.direction);
  }

  /**
   * Only one direction answers "does existing consumer code still compile".
   *
   * That question is drop-in replaceability: can the new declaration be used
   * everywhere the old one was, i.e. is new assignable to old. If only the
   * other direction fails, the API became more permissive (a parameter accepts
   * more, a return type is narrower), which existing callers cannot notice.
   *
   * StorageImage is the worked example: its prop went from JSX.Element to
   * React.ReactNode, so old is no longer assignable to new, but every existing
   * call still compiles. Treating that as breaking was wrong.
   */
  const kindOf = (name) => {
    const dirs = failures.get(name);
    return dirs.has('new->old') ? 'breaking' : 'permissive';
  };

  // Only breaking failures propagate: a symbol whose dependency merely became
  // more permissive has not itself broken.
  const breakingFailures = new Map([...failures].filter(([name]) => kindOf(name) === 'breaking'));
  const permissive = [...failures.keys()].filter((name) => kindOf(name) === 'permissive');

  const { roots, derived, cyclic } = attribute(breakingFailures, newExports);

  console.log(`exports: ${oldExports.size} -> ${newExports.size}`);
  if (removed.length) console.log(`REMOVED (always breaking): ${removed.join(', ')}`);
  if (added.length) console.log(`added (additive): ${added.join(', ')}`);
  if (permissive.length) console.log(`\npermissive (more accepting; existing code still compiles): ${permissive.join(', ')}`);
  console.log(`\nbreaking symbols: ${breakingFailures.size}${cyclic ? '  (cyclic, no independent root)' : ''}`);
  console.log(`root causes: ${roots.length}`);
  for (const name of roots) console.log(`  * ${name}`);
  console.log(`derived (consequences of the above): ${derived.length}`);
  for (const { name, via } of derived.slice(0, 4)) console.log(`  - ${name} via ${via.join(', ')}`);
  if (derived.length > 4) console.log(`  ... and ${derived.length - 4} more`);

  const isBreaking = removed.length > 0 || breakingFailures.size > 0;
  const isAdditive = added.length > 0 || permissive.length > 0;
  console.log(`\nverdict: ${isBreaking ? 'BREAKING (needs a major)' : isAdditive ? 'ADDITIVE (needs a minor)' : 'NO CHANGE (patch is fine)'}`);
}

main();
