// Prints the production bundle breakdown (raw + gzip). Runs after `vite build`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = resolve(import.meta.dirname, '../dist');
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    statSync(p).isDirectory() ? walk(p) : files.push(p);
  }
})(dist);
const size = (p) => {
  const b = readFileSync(p);
  return { raw: b.length, gz: gzipSync(b, { level: 9 }).length };
};
const kb = (n) => `${(n / 1024).toFixed(2)} KB`;
const rel = (p) => relative(dist, p);

const imports = (file) => {
  const src = readFileSync(file, 'utf8');
  const stat = [...src.matchAll(/(?:from\s*|import\s*)["'`](\.[^"'`]+\.js)["'`]/g)].map((m) => m[1]);
  const dyn = [...src.matchAll(/import\(\s*["'`](\.[^"'`]+\.js)["'`]\s*\)/g)].map((m) => m[1]);
  const abs = (l) => l.map((x) => resolve(dirname(file), x)).filter(existsSync);
  return { stat: abs(stat.filter((x) => !dyn.includes(x))), dyn: abs(dyn) };
};
const closure = (entry) => {
  const seen = new Set([entry]);
  const lazy = new Set();
  const q = [entry];
  while (q.length) {
    const f = q.pop();
    const { stat, dyn } = imports(f);
    for (const s of stat)
      if (!seen.has(s)) {
        seen.add(s);
        q.push(s);
      }
    for (const d of dyn) lazy.add(d);
  }
  return { eager: [...seen], lazy: [...lazy].filter((l) => !seen.has(l)) };
};
const sum = (list) =>
  list.reduce((a, f) => ({ raw: a.raw + size(f).raw, gz: a.gz + size(f).gz }), { raw: 0, gz: 0 });

const js = files.filter((f) => f.endsWith('.js') && !f.endsWith('theme-boot.js'));
const css = files.filter((f) => f.endsWith('.css'));
const bg = closure(join(dist, 'background.js'));
const popup = closure(join(dist, 'popup.js'));
const lazySize = sum(popup.lazy);

const row = (label, s) =>
  console.log(`  ${label.padEnd(34)} ${kb(s.raw).padStart(10)}  gzip ${kb(s.gz).padStart(9)}`);
console.log('\nBundle report (dist/)');
row('total JS', sum(js));
row('popup JS (first paint, eager)', sum(popup.eager));
row('popup JS (lazy tabs, on demand)', lazySize);
row('background JS (service worker)', sum(bg.eager));
row('CSS', sum(css));
row('theme-boot.js (blocking, tiny)', size(join(dist, 'theme-boot.js')));
const all = sum(files);
row('everything in dist/ (incl. icons)', all);
console.log('\n  Files:');
for (const f of js.concat(css))
  console.log(`    ${rel(f).padEnd(34)} ${kb(size(f).raw).padStart(10)}  gzip ${kb(size(f).gz).padStart(9)}`);
const pkg = JSON.parse(readFileSync(resolve(dist, '../package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});
console.log(
  `\n  Runtime dependencies bundled: ${deps.length === 0 ? '0 (everything is first-party code)' : deps.join(', ')}`,
);
