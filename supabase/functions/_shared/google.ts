// 用服務帳號（GOOGLE_SA_JSON）向 Google 換取存取權杖
let cache: { token: string; exp: number; scope: string } | null = null;

const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ''; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function googleToken(scope: string): Promise<string> {
  if (cache && cache.scope === scope && cache.exp > Date.now() + 60_000) return cache.token;
  const raw = Deno.env.get('GOOGLE_SA_JSON');
  if (!raw) throw Object.assign(new Error('missing GOOGLE_SA_JSON'), { code: 'missing_sa' });
  let sa: { client_email: string; private_key: string; token_uri?: string };
  try { sa = JSON.parse(raw); } catch { throw Object.assign(new Error('bad GOOGLE_SA_JSON'), { code: 'bad_sa' }); }
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({ iss: sa.client_email, scope, aud, iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const r = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(sig) }),
  });
  const j = await r.json();
  if (!j.access_token) throw Object.assign(new Error('token: ' + JSON.stringify(j)), { code: 'sa_auth_failed' });
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000, scope };
  return j.access_token;
}
