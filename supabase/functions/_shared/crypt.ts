// AES-GCM 加解密（存 refresh token 用）。金鑰由 SUPABASE_SERVICE_ROLE_KEY（或 GTOKEN_KEY）＋用途字串推導。
import { decodeBase64, encodeBase64 } from './b64.ts';

const keys = new Map<string, CryptoKey>();
async function key(purpose: string) {
  const k = keys.get(purpose);
  if (k) return k;
  const seed = Deno.env.get('GTOKEN_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed + ':' + purpose));
  const ck = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  keys.set(purpose, ck);
  return ck;
}
export async function encrypt(purpose: string, s: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(purpose), new TextEncoder().encode(s));
  return encodeBase64(iv) + '.' + encodeBase64(new Uint8Array(ct));
}
export async function decrypt(purpose: string, s: string) {
  const [iv, ct] = s.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64(iv) }, await key(purpose), decodeBase64(ct));
  return new TextDecoder().decode(pt);
}
