/** SHA-256 (native, async) truncated to 16 hex chars. Used to decide whether a PAC changed. */
export async function hashString(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const b = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < 8; i++) out += (b[i]! + 0x100).toString(16).slice(1);
  return out;
}
