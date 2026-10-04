import type { Action, Rule } from '../types/index.ts';
import { normalizePattern } from './normalize.ts';

export interface ImportIssue {
  line: number;
  text: string;
  error: string;
}

export interface ImportResult {
  rules: Rule[];
  lines: number;
  duplicates: number;
  /** First MAX_ISSUES problems only, so a 50k-line garbage file cannot balloon memory. */
  issues: ImportIssue[];
  invalid: number;
}

const MAX_ISSUES = 100;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;

const ACTIONS: Record<string, Action> = {
  direct: 'direct',
  proxy: 'proxy',
  pac: 'pac',
  yes: 'proxy',
  no: 'direct',
};

/**
 * Accepted line formats (one rule per line):
 *   example.com
 *   *.example.org
 *   example.com DIRECT          (also "," or tab as separator; yes/no = legacy aliases)
 *   #off example.com PROXY      (a disabled rule, as written by exportRules)
 *   # comment    // comment
 * Single pass over the text with indexOf: no split(), no regex, one object per accepted rule.
 */
export function parseImport(text: string, defaultAction: Action = 'proxy'): ImportResult {
  const byPattern = new Map<string, Rule>();
  const issues: ImportIssue[] = [];
  let invalid = 0;
  let duplicates = 0;
  let lines = 0;
  let pos = 0;
  const n = text.length;
  while (pos <= n) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = n;
    lines++;
    let line = text.slice(pos, end).trim();
    const lineNo = lines;
    pos = end + 1;
    if (line === '') continue;

    // Lists copied from chat/markdown contain links like `*.[www.example.com](https://www.example.com)`: keep the link text.
    if (line.includes('](')) line = line.replace(MD_LINK, '$1');

    let enabled = true;
    const c0 = line.charCodeAt(0);
    if (c0 === 35 && line.startsWith('#off ')) {
      enabled = false;
      line = line.slice(5).trim();
    } else if (c0 === 35 || c0 === 59 || (c0 === 47 && line.charCodeAt(1) === 47)) {
      continue;
    }

    let sep = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 32 || c === 9 || c === 44) {
        sep = i;
        break;
      }
    }
    const patternText = sep < 0 ? line : line.slice(0, sep);
    let action = defaultAction;
    if (sep >= 0) {
      const word = line
        .slice(sep + 1)
        .trim()
        .replace(/^,+/, '')
        .trim()
        .toLowerCase();
      if (word !== '') {
        const a = ACTIONS[word];
        if (!a) {
          invalid++;
          if (issues.length < MAX_ISSUES)
            issues.push({
              line: lineNo,
              text: line.slice(0, 80),
              error: `unknown action "${word.slice(0, 20)}"`,
            });
          continue;
        }
        action = a;
      }
    }
    const norm = normalizePattern(patternText);
    if (!norm.ok) {
      invalid++;
      if (issues.length < MAX_ISSUES)
        issues.push({ line: lineNo, text: line.slice(0, 80), error: norm.error });
      continue;
    }
    if (byPattern.has(norm.pattern)) duplicates++;
    byPattern.set(norm.pattern, { pattern: norm.pattern, action, enabled });
  }
  return { rules: [...byPattern.values()], lines, duplicates, issues, invalid };
}

/** Text export, round-trips through parseImport. */
export function exportRules(rules: readonly Rule[]): string {
  const sorted = [...rules].sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  const out: string[] = [];
  for (const r of sorted) out.push(`${r.enabled ? '' : '#off '}${r.pattern} ${r.action.toUpperCase()}`);
  return `${out.join('\n')}\n`;
}
