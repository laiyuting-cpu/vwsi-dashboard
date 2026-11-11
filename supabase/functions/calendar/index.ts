// 讀行事曆：
//   mode 'company'（預設）：公司行事曆 COMPANY_CALENDAR_ID
//   mode 'members'：夥伴分享給服務帳號的個人行事曆。分享「完整內容」回傳行程標題；只分享「忙碌／有空」只回傳時段。
// 正職、實習、主管看得到大家的；委外只看得到自己的。
import { cors, json } from '../_shared/slack.ts';
import { googleToken } from '../_shared/google.ts';
import { memberClient } from '../_shared/auth.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const memo = new Map<string, { at: number; body: unknown }>();
const dOk = (s?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') ? s! : '');
type Ev = { summary?: string; start: unknown; end: unknown; location?: string; htmlLink?: string; busy?: boolean };

async function listEvents(token: string, cal: string, from: string, to: string) {
  const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events`);
  u.search = new URLSearchParams({ timeMin: `${from}T00:00:00+08:00`, timeMax: `${to}T23:59:59+08:00`, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeZone: 'Asia/Taipei' }).toString();
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

async function freeBusy(token: string, cals: string[], from: string, to: string) {
  const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: `${from}T00:00:00+08:00`, timeMax: `${to}T23:59:59+08:00`, timeZone: 'Asia/Taipei', items: cals.map((id) => ({ id })) }),
  });
  const j = await r.json().catch(() => ({}));
  return (j.calendars ?? {}) as Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }>;
}

// 服務帳號的日曆清單（分享給 vwsi-bot 並登記過的日曆）
async function calList(token: string) {
  const r = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  return ((j.items ?? []) as { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; accessRole?: string; primary?: boolean }[])
    .filter((c) => !c.primary && !String(c.id).endsWith('.iam.gserviceaccount.com'));
}
async function calInsert(token: string, id: string) {
  const r = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const svc = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
async function calCfg(): Promise<{ extra: { id: string; name: string }[]; hidden: string[] }> {
  const { data } = await svc().from('org_settings').select('data').eq('id', 'calendars').maybeSingle();
  return { extra: (data?.data?.extra ?? []) as { id: string; name: string }[], hidden: (data?.data?.hiddenByDefault ?? []) as string[] };
}
const COMPANY = () => Deno.env.get('COMPANY_CALENDAR_ID') || 'vwsi.campmanagement@gmail.com';
// 公司相關日曆：公司帳號主日曆 + 服務帳號清單裡標記為公司的（名稱或 ID 登記在 company_cals）
const PALETTE = ['#2f6fb3', '#c7882b', '#3b8b5a', '#8a5bb3', '#b34a4a', '#2b8a8a', '#6b7a8a'];

const toLocal = (iso: string) => new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const cronKey = req.headers.get('x-cron-secret');
  if (cronKey) {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: okSecret } = await admin.rpc('check_cron_secret', { s: cronKey });
    if (!okSecret) return json({ ok: false, error: 'forbidden' }, 403);
    const body = await req.json().catch(() => ({}));
    const token = await googleToken(SCOPE);
    const today = new Date().toISOString().slice(0, 10);
    const probe = await Promise.all(((body.probe ?? []) as string[]).slice(0, 30).map(async (id) => { const r = await listEvents(token, id, today, today); return { id, status: r.status, name: r.j?.summary }; }));
    const added = [];
    for (const id of (body.add ?? []) as string[]) { const r = await calInsert(token, id); added.push({ id, status: r.status }); }
    return json({ ok: true, list: (await calList(token)).map((c) => ({ id: c.id, name: c.summary, role: c.accessRole })), probe, added });
  }
  const who = await memberClient(req);
  if (!who) return json({ ok: false, error: 'not_member' }, 403);
  let q: { from?: string; to?: string; mode?: string; ids?: string[]; id?: string; probe?: string[] } = {};
  try { q = await req.json(); } catch { /* 預設 */ }
  const from = dOk(q.from) || new Date().toISOString().slice(0, 10);
  const to = dOk(q.to) || new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);

  try {
    const token = await googleToken(SCOPE);

    if (q.mode === 'addCal' || q.mode === 'removeCal') {
      const { data: admin } = await who.sb.rpc('is_admin');
      if (!admin) return json({ ok: false, error: 'admin_only' }, 403);
      const id = String(q.id || '').trim();
      if (!id || id.length > 200) return json({ ok: false, error: 'bad_id' }, 400);
      const cfg = await calCfg();
      let extra = cfg.extra.filter((c) => c.id !== id);
      let name = id;
      if (q.mode === 'addCal') {
        const t = await listEvents(token, id, from, from);
        if (t.status !== 200) return json({ ok: false, error: t.status === 404 || t.status === 403 ? 'not_shared' : 'google_error' });
        name = t.j?.summary || id;
        extra = [...extra, { id, name }];
      }
      await svc().from('org_settings').upsert({ id: 'calendars', data: { extra, hiddenByDefault: cfg.hidden }, updated_at: new Date().toISOString() });
      memo.clear();
      return json({ ok: true, name });
    }
    if (q.mode === 'members') {
      const { data: staff } = await who.sb.rpc('is_staff');
      const { data: rows } = await who.sb.from('members').select('id,data');
      let ms = (rows ?? []).filter((r) => r.data?.active !== false);
      if (!staff) ms = ms.filter((r) => r.id === who.mid);
      if (Array.isArray(q.ids) && q.ids.length) ms = ms.filter((r) => q.ids!.includes(r.id));
      const key = 'm:' + who.mid + from + to + ms.map((r) => r.id).join(',');
      const hit = memo.get(key);
      if (hit && Date.now() - hit.at < 120_000) return json(hit.body);

      const out: Record<string, { status: string; events: Ev[] }> = {};
      const needFb: { mid: string; cal: string }[] = [];
      await Promise.all(ms.map(async (r) => {
        const cal = String(r.data?.calendarId || r.data?.email || '').trim();  // 沒填就用登入 Email
        if (!cal) { out[r.id] = { status: 'none', events: [] }; return; }
        const { status, j } = await listEvents(token, cal, from, to);
        if (status === 200) {
          const ev = (j.items ?? []).filter((e: Record<string, unknown>) => e.status !== 'cancelled' && e.transparency !== 'transparent')
            .filter((e: { attendees?: { self?: boolean; responseStatus?: string }[] }) => !(e.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined'))
            .map((e: Record<string, unknown>) => ({ summary: e.summary || '（無標題）', start: e.start, end: e.end, location: e.location }));
          // 只分享「忙碌／有空」時，Google 仍會回 200 但沒有標題
          const details = (j.items ?? []).some((e: { summary?: string }) => e.summary) || (j.accessRole && j.accessRole !== 'freeBusyReader');
          out[r.id] = details ? { status: 'full', events: ev } : { status: 'busy', events: ev.map((e: Ev) => ({ start: e.start, end: e.end, busy: true })) };
        } else needFb.push({ mid: r.id, cal });
      }));
      if (needFb.length) {
        const fb = await freeBusy(token, needFb.map((x) => x.cal), from, to);
        for (const { mid, cal } of needFb) {
          const c = fb[cal];
          if (!c || (c.errors ?? []).length) out[mid] = { status: 'not_shared', events: [] };
          else out[mid] = { status: 'busy', events: (c.busy ?? []).map((b) => ({ start: { dateTime: toLocal(b.start) }, end: { dateTime: toLocal(b.end) }, busy: true })) };
        }
      }
      // 勾選「行程標題只給我自己看」的人：別人只看到忙碌時段
      for (const r of ms) {
        const o = out[r.id];
        if (o && o.status === 'full' && r.data?.calPrivate && r.id !== who.mid) {
          out[r.id] = { status: 'busy', events: o.events.map((e) => ({ start: e.start, end: e.end, busy: true })) };
        }
      }
      const body = { ok: true, members: out };
      memo.set(key, { at: Date.now(), body });
      return json(body);
    }

    const main = COMPANY();
    const cfg = await calCfg();
    const cals = [{ id: main, name: '' }, ...cfg.extra.filter((c) => c.id !== main)];
    if (q.mode === 'cals') return json({ ok: true, calendars: cals.map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length], hide: cfg.hidden.includes(c.id) })) });
    const key = 'c:' + cals.map((c) => c.id).join(',') + from + to;
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < 120_000) return json(hit.body);
    const res = await Promise.all(cals.map((c) => listEvents(token, c.id, from, to)));
    if (res[0].status !== 200 && res.every((r) => r.status !== 200)) return json({ ok: false, error: res[0].status === 404 || res[0].status === 403 ? 'not_shared' : 'google_error', detail: res[0].j?.error?.message }, 502);
    const calendars = cals.map((c, i) => ({ id: c.id, name: c.name || res[i].j?.summary || c.id, color: PALETTE[i % PALETTE.length], ok: res[i].status === 200, hide: cfg.hidden.includes(c.id) }));
    const events = res.flatMap((r, i) => r.status !== 200 ? [] : (r.j.items ?? []).filter((e: { status?: string }) => e.status !== 'cancelled').map((e: Record<string, unknown>) => ({
      summary: e.summary, start: e.start, end: e.end, location: e.location, htmlLink: e.htmlLink, cal: cals[i].id,
    })));
    const body = { ok: true, events, calendars };
    memo.set(key, { at: Date.now(), body });
    return json(body);
  } catch (e) {
    return json({ ok: false, error: (e as { code?: string }).code || 'error', detail: String((e as Error).message).slice(0, 200) }, 500);
  }
});
