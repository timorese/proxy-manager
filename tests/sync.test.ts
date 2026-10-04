import { describe, expect, it } from 'vitest';
import { makeEnv, pacSource, proxyServer, rule } from './helpers/env.ts';
import { loadPac, resolveHost } from './helpers/pac-runner.ts';

const SRC = 'function FindProxyForURL(u,h){ return h.endsWith(".corp") ? "PROXY corp:8080" : "DIRECT"; }';

async function setup(
  env: ReturnType<typeof makeEnv>,
  opts: { mode?: 'direct' | 'proxy' | 'pac'; enabled?: boolean } = {},
) {
  const { repos } = env;
  await repos.settings.update({ enabled: opts.enabled ?? true, mode: opts.mode ?? 'direct' });
  await repos.proxies.save([proxyServer('p1', '127.0.0.1', 1080)]);
  await repos.revision.bump();
}

describe('integration: config -> PAC -> chrome.proxy', () => {
  it('exact, wildcard, subdomain, DIRECT, PROXY, PAC, fallback (spec example)', async () => {
    const env = makeEnv();
    await setup(env);
    await env.repos.pacs.put(pacSource('s1'), SRC);
    await env.repos.rules.putMany([
      rule('example.com', 'pac'),
      rule('x.corp', 'pac'),
      rule('*.google.com', 'proxy'),
      rule('mail.google.com', 'direct'),
    ]);
    await env.repos.revision.bump();

    const r = await env.engine.sync();
    expect(r.applied).toBe(true);
    expect(env.proxy.calls).toHaveLength(1);
    const f = loadPac(env.proxy.pac());
    const chain = 'SOCKS5 127.0.0.1:1080; DIRECT';
    expect(resolveHost(f, 'mail.google.com')).toBe('DIRECT');
    expect(resolveHost(f, 'maps.google.com')).toBe(chain);
    expect(resolveHost(f, 'google.com')).toBe(chain);
    expect(resolveHost(f, 'example.com')).toBe('DIRECT'); // PAC says DIRECT for it
    expect(resolveHost(f, 'x.corp')).toBe('PROXY corp:8080'); // PAC rule consults the source
    expect(resolveHost(f, 'unlisted.org')).toBe('DIRECT'); // fallback (mode direct)
  });

  it('master switch off clears control and never installs a PAC', async () => {
    const env = makeEnv();
    await setup(env, { enabled: false });
    await env.repos.rules.putMany([rule('a.com', 'proxy')]);
    await env.repos.revision.bump();
    const r = await env.engine.sync();
    expect(env.proxy.calls.map((c) => c.op)).toEqual(['clear']);
    expect(r.state.appliedKind).toBe('clear');
  });

  it('disabled rules are not compiled', async () => {
    const env = makeEnv();
    await setup(env);
    await env.repos.rules.putMany([rule('on.com', 'proxy'), rule('off.com', 'proxy', false)]);
    await env.repos.revision.bump();
    await env.engine.sync();
    const f = loadPac(env.proxy.pac());
    expect(resolveHost(f, 'on.com')).toContain('SOCKS5');
    expect(resolveHost(f, 'off.com')).toBe('DIRECT');
  });

  it('disabled PAC source is ignored', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'pac' });
    await env.repos.pacs.put(pacSource('s1', { enabled: false }), SRC);
    await env.repos.revision.bump();
    const r = await env.engine.sync();
    expect(r.state.appliedKind).toBe('direct'); // nothing to route
    expect(env.proxy.calls[0]?.value?.mode).toBe('direct');
  });

  it('multiple proxies become one failover chain', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    await env.repos.proxies.save([
      proxyServer('a', '127.0.0.1', 1080, 'socks5'),
      proxyServer('b', 'backup', 1080, 'socks5'),
      proxyServer('c', 'proxy.example.com', 443, 'https'),
      proxyServer('d', 'off', 1, 'http', false),
    ]);
    await env.repos.revision.bump();
    await env.engine.sync();
    expect(resolveHost(loadPac(env.proxy.pac()), 'x.org')).toBe(
      'SOCKS5 127.0.0.1:1080; SOCKS5 backup:1080; HTTPS proxy.example.com:443; DIRECT',
    );
  });

  it('invalid PAC source is excluded, reported, and does not break the rest', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'pac' });
    await env.repos.pacs.put(
      pacSource('bad', { name: 'Broken' }),
      'function FindProxyForURL(u,h){ return "PROXY a:1"; ',
    ); // truncated
    await env.repos.pacs.put(pacSource('good', { name: 'Good' }), SRC);
    await env.repos.revision.bump();
    const r = await env.engine.sync();
    expect(r.state.errors.map((e) => e.code)).toContain('pac_compile_failed');
    expect(r.state.errors[0]?.message).toMatch(/Broken/);
    expect(resolveHost(loadPac(env.proxy.pac()), 'a.corp')).toBe('PROXY corp:8080');
  });

  it('offline PAC source with a previously downloaded body still works (last known good)', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'pac' });
    await env.repos.pacs.put(
      pacSource('u', {
        kind: 'url',
        url: 'https://pac.example/p.pac',
        fetch: {
          lastAttemptAt: 5,
          lastSuccessAt: 1,
          etag: '',
          lastModified: '',
          hash: 'h',
          bytes: 10,
          error: 'timeout',
        },
      }),
      SRC,
    );
    await env.repos.revision.bump();
    const r = await env.engine.sync();
    expect(r.applied).toBe(true);
    expect(resolveHost(loadPac(env.proxy.pac()), 'a.corp')).toBe('PROXY corp:8080');
  });

  it('enabled URL source that never downloaded is reported, not applied as broken JS', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'pac' });
    await env.repos.pacs.put(pacSource('u', { kind: 'url', url: 'https://x/p.pac' }));
    await env.repos.revision.bump();
    const r = await env.engine.sync();
    expect(r.state.errors.some((e) => e.code === 'pac_compile_failed')).toBe(true);
  });

  it('invalid proxy and invalid rules are surfaced as typed errors', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    await env.repos.proxies.save([
      proxyServer('bad', 'bad host!', 1080),
      proxyServer('ok', 'ok.example', 1080),
    ]);
    await env.repos.rules.putMany([rule('not a domain!', 'proxy')]);
    await env.repos.revision.bump();
    const r = await env.engine.sync();
    const codes = r.state.errors.map((e) => e.code);
    expect(codes).toContain('invalid_proxy');
    expect(codes).toContain('invalid_rule');
  });

  it('chrome rejecting the settings is reported and retried on the next sync', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    env.proxy.failNextSet = 'boom';
    const r1 = await env.engine.sync();
    expect(r1.applied).toBe(false);
    expect(r1.state.errors[0]?.code).toBe('proxy_rejected');
    const r2 = await env.engine.sync();
    expect(r2.applied).toBe(true);
    expect(r2.state.errors).toHaveLength(0);
  });

  it('reports when another extension controls the proxy', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    env.proxy.level = 'controlled_by_other_extensions';
    const r = await env.engine.sync();
    expect(r.state.errors.map((e) => e.code)).toContain('controlled_by_other');
  });
});

describe('PAC is not rebuilt / re-applied without a reason', () => {
  it('same revision: no reads of rules, no compile, no chrome.proxy call', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    await env.engine.sync();
    expect(env.proxy.calls).toHaveLength(1);
    const before = env.kv.reads;
    const r = await env.engine.sync();
    expect(r.skipped).toBe('up-to-date');
    expect(env.proxy.calls).toHaveLength(1);
    expect(env.kv.reads - before).toBe(2); // rev + state only
  });

  it('new revision but identical PAC (toggling an unused thing): hash match, no set()', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    await env.repos.rules.putMany([rule('a.com', 'proxy')]);
    await env.repos.revision.bump();
    await env.engine.sync();
    // Edits that cannot change the output: disable a rule that was already disabled, add a rule that is redundant, add a disabled rule.
    await env.repos.rules.putMany([rule('zzz.com', 'proxy', false), rule('sub.a.com', 'proxy')]);
    await env.repos.revision.bump();
    const r = await env.engine.sync();
    expect(r.skipped).toBe('same-hash');
    expect(env.proxy.calls).toHaveLength(1);
  });

  it('a real change applies exactly once', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    await env.engine.sync();
    await env.repos.rules.putMany([rule('direct.com', 'direct')]);
    await env.repos.revision.bump();
    const r = await env.engine.sync();
    expect(r.applied).toBe(true);
    expect(env.proxy.calls).toHaveLength(2);
  });

  it('force re-applies', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    await env.engine.sync();
    await env.engine.sync({ force: true });
    expect(env.proxy.calls).toHaveLength(2);
  });

  it('concurrent syncs are coalesced into at most two runs', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    const results = await Promise.all(Array.from({ length: 10 }, () => env.engine.sync()));
    expect(env.proxy.calls).toHaveLength(1);
    expect(results.every((r) => r.hash === results[0]?.hash)).toBe(true);
  });

  it('survives a worker restart: a fresh engine on the same storage does not re-apply', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    await env.engine.sync();
    const { SyncEngine } = await import('../src/background/sync.ts');
    const reborn = new SyncEngine({ repos: env.repos, proxyApi: env.proxy });
    const r = await reborn.sync();
    expect(r.skipped).toBe('up-to-date');
    expect(env.proxy.calls).toHaveLength(1);
  });

  it('verify(): O(1) on startup, re-applies only if Chrome lost control', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    await env.engine.sync();
    await env.engine.verify();
    expect(env.proxy.calls).toHaveLength(1);
    env.proxy.level = 'controllable_by_this_extension';
    await env.engine.verify();
    expect(env.proxy.calls).toHaveLength(2);
  });

  it('runtime proxy errors are deduplicated and cleared by the next real apply', async () => {
    const env = makeEnv();
    await setup(env, { mode: 'proxy' });
    await env.engine.sync();
    await env.engine.recordRuntimeError('PAC_SCRIPT_ERROR');
    const writes = env.kv.writes;
    await env.engine.recordRuntimeError('PAC_SCRIPT_ERROR');
    expect(env.kv.writes).toBe(writes);
    expect((await env.repos.state.get()).errors).toHaveLength(1);
    await env.repos.rules.putMany([rule('d.com', 'direct')]);
    await env.repos.revision.bump();
    const r = await env.engine.sync();
    expect(r.state.errors).toHaveLength(0);
  });
});
