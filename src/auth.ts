// Minimal session: an HMAC-signed token stored in an httpOnly cookie.
// Token format: `v2.<expiryMs>.<epoch>.<base64url(hmac)>`. The signature
// covers the epoch, and a token is only valid while its epoch equals the
// server's current one — bumping the epoch ("sign out everywhere") revokes
// every outstanding session without keeping a session table.

const encoder = new TextEncoder();

function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64url(sig);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSession(secret: string, ttlMs: number, epoch: number): Promise<string> {
  const payload = `v2.${Date.now() + ttlMs}.${epoch}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifySession(token: string, secret: string, epoch: number): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") return false;
  const [v, exp, tokenEpoch, sig] = parts;
  if (!constantTimeEqual(sig, await hmac(secret, `${v}.${exp}.${tokenEpoch}`))) return false;
  if (Number(tokenEpoch) !== epoch) return false;
  return Number(exp) > Date.now();
}

// Compares HMACs of both values rather than the values themselves, so the
// comparison time reveals neither the passcode's length nor a matching prefix.
export async function passcodeMatches(input: string, expected: string, secret: string): Promise<boolean> {
  if (typeof input !== "string" || typeof expected !== "string") return false;
  const [a, b] = await Promise.all([hmac(secret, "pw:" + input), hmac(secret, "pw:" + expected)]);
  return constantTimeEqual(a, b);
}
