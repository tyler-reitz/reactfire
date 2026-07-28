// Strip `private`/`protected` member declarations from a .d.ts tree.
// They are emitted for layout reasons but are not part of the public contract,
// and they are what makes TS treat two copies of a class as nominally distinct.
import fs from 'node:fs';
import path from 'node:path';
const strip = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      strip(p);
      continue;
    }
    if (!e.name.endsWith('.d.ts')) continue;
    const out = fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(private|protected)\s+\w/.test(l))
      .join('\n');
    fs.writeFileSync(p, out);
  }
};
strip(process.argv[2]);
