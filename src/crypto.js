/**
 * The bible holds the ending. It rests in D1 encrypted (AES-GCM) with a key derived from the
 * BIBLE_KEY secret, so whoever opens the database in the Cloudflare dashboard reads no spoiler.
 * WebCrypto only: the same code runs in the Worker and in Node.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

async function keyFrom(secret) {
  if (typeof secret !== "string" || secret.length < 16) throw new Error("BIBLE_KEY must be at least 16 characters");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`ztales-bible:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function seal(secret, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFrom(secret), enc.encode(JSON.stringify(value)));
  // chunked: String.fromCharCode(...bigArray) overflows the call stack on large bibles
  const bytes = new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `v1.${b64(iv)}.${btoa(s)}`;
}

export async function open(secret, sealed) {
  const [v, iv, body] = String(sealed).split(".");
  if (v !== "v1" || !iv || !body) throw new Error("not a sealed bible");
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await keyFrom(secret), unb64(body));
  return JSON.parse(dec.decode(data));
}
