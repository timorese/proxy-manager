// Zips dist/ into pac-proxy-manager-<version>.zip (run after `npm run build`).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const out = `pac-proxy-manager-${version}.zip`;
execFileSync('zip', ['-r', '-X', `../${out}`, '.'], { cwd: new URL('../dist', import.meta.url), stdio: 'inherit' });
console.log(`created ${out}`);
