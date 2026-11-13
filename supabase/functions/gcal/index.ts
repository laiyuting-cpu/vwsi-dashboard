// 個人 Google 日曆（每個人用自己的 Google 帳號授權）：讀取、新增、修改、刪除活動，邀請與會者、回覆邀請。
// 需要 Supabase Secrets：GOOGLE_OAUTH_CLIENT_ID、GOOGLE_OAUTH_CLIENT_SECRET（Google Cloud「OAuth 用戶端 ID」，類型：網頁應用程式）。
// refresh token 用 AES-GCM 加密後存在 private.gtokens（備份檔裡也是密文）。
import { cors, json } from '../_shared/slack.ts';
import { memberClient } from '../_shared/auth.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { decodeBase64, encodeBase64 } from '../_shared/b64.ts';

const CAL = 'https://www.googleapis.com/calendar/v3';
const NEED = 'https://www.googleapis.com/auth/calendar.events';
const TZ = 'Asia/Taipei';
const svc = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CID = () => Deno.env.get('GOOGLE_OAUTH_CLIENT_ID') || '';
const CSEC = () => Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET') || '';
const fail = (code: string, detail?: string, status = 400) => Object.assign(new Error(detail || code), { code, status });

let aesKey: CryptoKey | null = null;
async function key() {
  if (aesKey) return aesKey;
  const seed = Deno.env.get('GTOKEN_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed + ':vwsi-gtoken'));
  aesKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return aesKey;
}
async function enc(s: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(s));
  return encodeBase64(iv) + '.' + encodeBase64(new Uint8Array(ct));
}
async function dec(s: string) {
  const [iv, ct] = s.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64(iv) }, await key(), decodeBase64(ct));
  return new TextDecoder().decode(pt);
}

const tokCache = new Map<string, { tok: string; exp: number }>();
async function access(mid: string) {
  const c = tokCache.get(mid);
  if (c && c.exp > Date.now() + 60_000) return c.tok;
  const { data: row } = await svc().rpc('gtoken_get', { p_mid: mid });
  if (!row) throw fail('not_connected', '', 409);
  let refresh = '';
  try { refresh = await dec(row.enc); } catch { await svc().rpc('gtoken_del', { p_mid: mid }); throw fail('reauth', 'decrypt', 409); }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CID(), client_secret: CSEC(), refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) {
    if (j.error === 'invalid_grant') { await svc().rpc('gtoken_del', { p_mid: mid }); throw fail('reauth', 'invalid_grant', 409); }
    throw fail('google_auth', JSON.stringify(j).slice(0, 200), 502);
  }
  tokCache.set(mid, { tok: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token as string;
}

async function g(tok: string, method: string, path: string, q?: Record<string, string>, body?: unknown) {
  const u = new URL(CAL + path);
  if (q) u.search = new URLSearchParams(q).toString();
  const r = await fetch(u, { method, headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || '';
    if (r.status === 403 || r.status === 404) throw fail(r.status === 404 ? 'not_found' : 'forbidden', msg, r.status);
    if (r.status === 401) { throw fail('reauth', msg, 409); }
    throw fail('google_error', `${r.status} ${msg}`.slice(0, 300), 502);
  }
  return j;
}

type GEvent = Record<string, any>;
function slim(e: GEvent, cal: string, role: string) {
  const self = (e.attendees ?? []).find((a: GEvent) => a.self);
  const mineOrg = !!e.organizer?.self || (!e.organizer && role !== 'reader');
  return {
    id: e.id, cal, summary: e.summary || '', start: e.start, end: e.end, location: e.location || '', description: e.description || '',
    attendees: (e.attendees ?? []).filter((a: GEvent) => !a.resource).map((a: GEvent) => ({ email: a.email, name: a.displayName || '', rs: a.responseStatus, self: !!a.self, org: !!a.organizer })),
    meet: e.hangoutLink || '', link: e.htmlLink || '', organizer: e.organizer?.email || '', mine: mineOrg,
    canEdit: (role === 'owner' || role === 'writer') && (mineOrg || !!e.guestsCanModify),
    rs: self?.responseStatus || '', recurring: !!e.recurringEventId, status: e.status,
  };
}

const okD = (s?: string) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const okT = (s?: string) => /^\d{2}:\d{2}$/.test(s ?? '');
const addDay = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const emailOk = (s: string) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const who = await memberClient(req);
  if (!who) return json({ ok: false, error: 'not_member' }, 403);
  let q: Record<string, any> = {};
  try { q = await req.json(); } catch { /* */ }
  const mid = who.mid;
  try {
    if (q.mode === 'status') {
      const { data: row } = await svc().rpc('gtoken_get', { p_mid: mid });
      return json({ ok: true, clientId: CID(), ready: !!(CID() && CSEC()), connected: !!row, email: row?.email || '' });
    }
    if (q.mode === 'connect') {
      if (!CID() || !CSEC()) throw fail('not_configured', '', 503);
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: String(q.code || ''), client_id: CID(), client_secret: CSEC(), redirect_uri: 'postmessage', grant_type: 'authorization_code' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.access_token) throw fail('exchange_failed', JSON.stringify(j).slice(0, 200));
      if (!String(j.scope || '').includes(NEED)) throw fail('scope_missing');
      if (!j.refresh_token) throw fail('no_refresh');
      let email = '';
      try { email = JSON.parse(new TextDecoder().decode(decodeBase64(j.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(j.id_token.split('.')[1].length / 4) * 4, '=')))).email || ''; } catch { /* */ }
      await svc().rpc('gtoken_put', { p_mid: mid, p_email: email, p_enc: await enc(j.refresh_token), p_scope: j.scope });
      tokCache.set(mid, { tok: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
      return json({ ok: true, email });
    }
    if (q.mode === 'disconnect') {
      const { data: row } = await svc().rpc('gtoken_get', { p_mid: mid });
      if (row) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(await dec(row.enc)), { method: 'POST' }); } catch { /* */ } }
      await svc().rpc('gtoken_del', { p_mid: mid });
      tokCache.delete(mid);
      return json({ ok: true });
    }

    const tok = await access(mid);
    const calList = async () => {
      const j = await g(tok, 'GET', '/users/me/calendarList', { maxResults: '250' });
      return ((j.items ?? []) as GEvent[]).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || '#006ebf', role: c.accessRole, primary: !!c.primary, hidden: !!c.hidden }));
    };
    const roleOf = async (cal: string) => {
      try { const c = await g(tok, 'GET', '/users/me/calendarList/' + encodeURIComponent(cal)); return c.accessRole as string; } catch { return 'writer'; }
    };

    if (q.mode === 'cals') return json({ ok: true, calendars: await calList() });

    if (q.mode === 'list') {
      const from = okD(q.from) ? q.from : new Date().toISOString().slice(0, 10);
      const to = okD(q.to) ? q.to : addDay(from, 7);
      const cals = await calList();
      const want = Array.isArray(q.cals) && q.cals.length ? cals.filter((c) => q.cals.includes(c.id)) : cals.filter((c) => c.primary);
      const out: unknown[] = [];
      await Promise.all(want.slice(0, 10).map(async (c) => {
        try {
          const j = await g(tok, 'GET', `/calendars/${encodeURIComponent(c.id)}/events`, { timeMin: `${from}T00:00:00+08:00`, timeMax: `${to}T23:59:59+08:00`, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeZone: TZ });
          for (const e of (j.items ?? []) as GEvent[]) if (e.status !== 'cancelled') out.push({ ...slim(e, c.id, c.role), color: c.color });
        } catch { /* 單一日曆失敗就略過 */ }
      }));
      return json({ ok: true, events: out, calendars: cals });
    }

    const cal = String(q.cal || 'primary');
    const id = q.id ? String(q.id) : '';
    const ep = `/calendars/${encodeURIComponent(cal)}/events`;

    if (q.mode === 'get') {
      const e = await g(tok, 'GET', `${ep}/${encodeURIComponent(id)}`, { timeZone: TZ });
      return json({ ok: true, event: slim(e, cal, await roleOf(cal)) });
    }

    if (q.mode === 'save') {
      const ev = q.ev || {};
      if (!okD(ev.date)) throw fail('bad_date');
      const body: GEvent = { summary: String(ev.summary || '').slice(0, 300) || '（無標題）', location: String(ev.location || '').slice(0, 500), description: String(ev.description || '').slice(0, 8000) };
      if (ev.allDay) {
        const end = okD(ev.endDate) && ev.endDate >= ev.date ? ev.endDate : ev.date;
        body.start = { date: ev.date }; body.end = { date: addDay(end, 1) };
      } else {
        if (!okT(ev.startTime) || !okT(ev.endTime)) throw fail('bad_time');
        const endDate = okD(ev.endDate) ? ev.endDate : (ev.endTime <= ev.startTime ? addDay(ev.date, 1) : ev.date);
        body.start = { dateTime: `${ev.date}T${ev.startTime}:00+08:00`, timeZone: TZ };
        body.end = { dateTime: `${endDate}T${ev.endTime}:00+08:00`, timeZone: TZ };
      }
      const emails = [...new Set(((ev.attendees ?? []) as string[]).map((s) => String(s).trim().toLowerCase()).filter(emailOk))].slice(0, 100);
      let existing: GEvent | null = null;
      if (id) existing = await g(tok, 'GET', `${ep}/${encodeURIComponent(id)}`);
      if (Array.isArray(ev.attendees)) {
        const prev = new Map(((existing?.attendees ?? []) as GEvent[]).map((a) => [String(a.email).toLowerCase(), a]));
        body.attendees = emails.map((e) => prev.get(e) || { email: e });
        // 保留會議室等資源
        for (const a of (existing?.attendees ?? []) as GEvent[]) if (a.resource) body.attendees.push(a);
      }
      if (ev.meet && !(existing?.hangoutLink)) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      const qs = { sendUpdates: ev.notify === false ? 'none' : 'all', conferenceDataVersion: '1' };
      const e = id ? await g(tok, 'PATCH', `${ep}/${encodeURIComponent(id)}`, qs, body) : await g(tok, 'POST', ep, qs, body);
      return json({ ok: true, event: slim(e, cal, 'writer') });
    }

    if (q.mode === 'delete') {
      await g(tok, 'DELETE', `${ep}/${encodeURIComponent(id)}`, { sendUpdates: q.notify === false ? 'none' : 'all' });
      return json({ ok: true });
    }

    if (q.mode === 'rsvp') {
      if (!['accepted', 'declined', 'tentative'].includes(q.rs)) throw fail('bad_rs');
      const e = await g(tok, 'GET', `${ep}/${encodeURIComponent(id)}`);
      const att = ((e.attendees ?? []) as GEvent[]).map((a) => (a.self ? { ...a, responseStatus: q.rs } : a));
      if (!att.some((a) => a.self)) throw fail('not_invited');
      const r = await g(tok, 'PATCH', `${ep}/${encodeURIComponent(id)}`, { sendUpdates: 'all' }, { attendees: att });
      return json({ ok: true, event: slim(r, cal, 'reader') });
    }

    return json({ ok: false, error: 'bad_mode' }, 400);
  } catch (e) {
    const err = e as { code?: string; status?: number; message?: string };
    return json({ ok: false, error: err.code || 'error', detail: String(err.message || '').slice(0, 300) }, err.status || 500);
  }
});
