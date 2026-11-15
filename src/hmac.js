// HMAC-SHA256 helpers (WebCrypto). Works in Cloudflare Workers and Node >= 18.
// The platform issues a 32-byte random secret at agent registration and shows it
// exactly once. It is NEVER committed to the repo — it lives in the Worker as a
// secret: `wrangler secret put AGENT_GAMES_HMAC_SECRET`.

const enc = new TextEncoder();

// Accept the secret as 64-char hex (the platform's 32-byte secret) or raw text.
export function normalizeSecret(secret) {
  if (typeof secret === "string" && /^[0-9a-fA-F]{64}$/.test(secret)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(secret.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  return enc.encode(secret);
}

export async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    normalizeSecret(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function hmacHex(key, data) {
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The platform sends the signature as bare hex by default; the `sha256=` prefixed
// form is the fallback to try if preflight rejects the default format.
export function parseSignatureHeader(header) {
  if (!header) return null;
  const h = header.trim().toLowerCase();
  if (h.startsWith("sha256=")) return h.slice(7);
  return h;
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Constant-time comparison (no timingSafeEqual in Workers).
export function constantTimeEqual(a, b) {
  const ab = typeof a === "string" ? hexToBytes(a) : a;
  const bb = typeof b === "string" ? hexToBytes(b) : b;
  if (!ab || !bb || ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// Verify an incoming request: HMAC-SHA256 over the RAW request body.
export async function verifySignature(secret, rawBody, header) {
  const expected = parseSignatureHeader(header);
  if (!expected) return false;
  const key = await importHmacKey(secret);
  const actual = await hmacHex(key, rawBody);
  return constantTimeEqual(actual, expected);
}

// Sign an outgoing response body (raw bytes).
export async function signBody(secret, rawBody) {
  const key = await importHmacKey(secret);
  return hmacHex(key, rawBody);
}
