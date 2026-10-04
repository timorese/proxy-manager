/**
 * Host-permission match pattern for a PAC URL. Extension match patterns ignore the port, and a pattern that
 * contains one (`https://host:8443/*`) is not a valid pattern, so the permission request used to fail silently
 * for PAC servers on non-standard ports.
 */
export function hostPermissionPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}
