import { describe, expect, it } from 'vitest';
import { hostPermissionPattern } from '../src/shared/origin.ts';

describe('hostPermissionPattern', () => {
  it('drops the port: match patterns ignore it and reject it', () => {
    expect(hostPermissionPattern('https://p.thenewone.lol:8443/proxy.pac')).toBe('https://p.thenewone.lol/*');
    expect(hostPermissionPattern('http://127.0.0.1:8080/x?y=1')).toBe('http://127.0.0.1/*');
    expect(hostPermissionPattern('https://example.com/a.pac')).toBe('https://example.com/*');
  });
});
