/**
 * Remove `private` and `protected` members from a .d.ts tree, in place.
 *
 * Why this exists: TypeScript types a class with private or protected members
 * *nominally*, so two structurally identical copies of the same declaration
 * loaded from different files are never assignable to each other. Without this,
 * comparing a version against itself reports the package as breaking, because
 * `SuspenseSubject` has fifteen private fields. Those members are emitted for
 * layout and are not part of the consumer-facing contract, so dropping them is
 * what makes the comparison structural.
 *
 * Done with the AST rather than by line matching. A line regex corrupts any
 * member whose declaration spans multiple lines:
 *
 *     private callback: (          <- the regex deletes only this line
 *         event: string,           <- leaving these behind as garbage
 *     ) => void;
 *
 * which produces a file that no longer parses, so the comparison silently
 * becomes meaningless instead of failing loudly.
 *
 * Usage: node strip-private.mjs <dir> [<dir>...]
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Remove private/protected member declarations from one .d.ts source. */
export function stripPrivateMembers(source, fileName = 'input.d.ts') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const spans = [];

  const visit = (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members) {
        const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
        const hidden = modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword);
        // `#field` is genuinely private too, and equally nominal.
        const isPrivateName = member.name && ts.isPrivateIdentifier(member.name);
        if (hidden || isPrivateName) {
          // getStart() skips leading trivia, so preceding comments and the
          // newline are left in place rather than swallowed with the member.
          spans.push([member.getStart(file), member.end]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  // Back to front, so earlier offsets stay valid as later spans are removed.
  let out = source;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

function stripTree(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += stripTree(target);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;
    const before = fs.readFileSync(target, 'utf8');
    const after = stripPrivateMembers(before, target);
    if (after !== before) {
      fs.writeFileSync(target, after);
      count++;
    }
  }
  return count;
}

if (process.argv.length > 2) {
  for (const dir of process.argv.slice(2)) {
    const changed = stripTree(path.resolve(dir));
    console.log(`stripped private members from ${changed} file(s) in ${dir}`);
  }
}
