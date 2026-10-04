import { describe, expect, it } from 'vitest';
import { hashString } from '../src/shared/hash.ts';
import { CURRENT_SCHEMA, ensureSchema, type Migration } from '../src/storage/schema.ts';
import { DEFAULT_SETTINGS } from '../src/types/index.ts';
import { MemoryKv, makeEnv, pacSource, proxyServer, rule } from './helpers/env.ts';

describe('RuleRepository (IndexedDB)', () => {
  it('putMany upserts by pattern, getAll/count/deleteMany/clear', async () => {
    const { repos } = makeEnv();
    await repos.rules.putMany([rule('a.com', 'proxy'), rule('*.b.com', 'direct')]);
    await repos.rules.putMany([rule('a.com', 'pac', false)]);
    const all = await repos.rules.getAll();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.pattern === 'a.com')).toEqual({
      pattern: 'a.com',
      action: 'pac',
      enabled: false,
    });
    expect(await repos.rules.count()).toBe(2);
    await repos.rules.deleteMany(['a.com', 'missing.com']);
    expect(await repos.rules.count()).toBe(1);
    await repos.rules.clear();
    expect(await repos.rules.count()).toBe(0);
  });

  it('writes 10 000 rules in a single transaction', async () => {
    const { repos } = makeEnv();
    const rules = Array.from({ length: 10_000 }, (_, i) => rule(`h${i}.example.com`, 'proxy'));
    await repos.rules.putMany(rules);
    expect(await repos.rules.count()).toBe(10_000);
  });
});

describe('PacRepository', () => {
  it('list() returns metadata only; bodies are separate; toggling does not rewrite the body', async () => {
    const { repos } = makeEnv();
    await repos.pacs.put(pacSource('a'), 'BODY-A');
    await repos.pacs.put(pacSource('b'), 'BODY-B');
    const list = await repos.pacs.list();
    expect(list.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(JSON.stringify(list)).not.toContain('BODY');
    await repos.pacs.put({ ...pacSource('a'), enabled: false });
    expect((await repos.pacs.get('a'))?.enabled).toBe(false);
    expect(await repos.pacs.getBody('a')).toBe('BODY-A');
    expect([...(await repos.pacs.getBodies(['a', 'b', 'zz'])).keys()].sort()).toEqual(['a', 'b']);
  });
  it('delete removes metadata and body', async () => {
    const { repos } = makeEnv();
    await repos.pacs.put(pacSource('a'), 'X');
    await repos.pacs.delete('a');
    expect(await repos.pacs.get('a')).toBeUndefined();
    expect(await repos.pacs.getBody('a')).toBeUndefined();
  });
});

describe('Settings / Proxy / Revision / State (chrome.storage)', () => {
  it('settings merge over defaults', async () => {
    const { repos, kv } = makeEnv();
    expect(await repos.settings.get()).toEqual(DEFAULT_SETTINGS);
    await repos.settings.update({ enabled: true });
    expect((await repos.settings.get()).enabled).toBe(true);
    kv.data.settings = { enabled: true }; // older record missing newer fields
    expect(await repos.settings.get()).toEqual({ ...DEFAULT_SETTINGS, enabled: true });
  });
  it('proxies roundtrip; revision changes on every bump', async () => {
    const { repos } = makeEnv();
    await repos.proxies.save([proxyServer('p', 'h')]);
    expect(await repos.proxies.list()).toHaveLength(1);
    const a = await repos.revision.bump();
    const b = await repos.revision.bump();
    expect(a).not.toBe(b);
    expect(await repos.revision.get()).toBe(b);
  });
});

describe('schema migrations', () => {
  it('runs pending steps in order exactly once and persists progress', async () => {
    const kv = new MemoryKv();
    const order: number[] = [];
    const steps: Record<number, Migration> = {
      1: async () => void order.push(1),
      2: async () => void order.push(2),
      3: async () => void order.push(3),
    };
    expect(await ensureSchema(kv, steps, 3)).toBe(3);
    expect(order).toEqual([1, 2, 3]);
    await ensureSchema(kv, steps, 3);
    expect(order).toEqual([1, 2, 3]);
    steps[4] = async () => void order.push(4);
    await ensureSchema(kv, steps, 4);
    expect(order).toEqual([1, 2, 3, 4]);
  });
  it('a failing step stops and resumes from there', async () => {
    const kv = new MemoryKv();
    let fail = true;
    const steps: Record<number, Migration> = {
      1: async () => {},
      2: async () => {
        if (fail) throw new Error('x');
      },
    };
    await expect(ensureSchema(kv, steps, 2)).rejects.toThrow();
    expect(kv.data.schema).toBe(1);
    fail = false;
    expect(await ensureSchema(kv, steps, 2)).toBe(2);
  });
  it('default migration set reaches CURRENT_SCHEMA', async () => {
    expect(await ensureSchema(new MemoryKv())).toBe(CURRENT_SCHEMA);
  });
});

describe('hashing', () => {
  it('is deterministic, 16 hex chars, and sensitive to a 1-char change', async () => {
    const a = await hashString('function FindProxyForURL(){}');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashString('function FindProxyForURL(){}')).toBe(a);
    expect(await hashString('function FindProxyForURL(){} ')).not.toBe(a);
  });
});
