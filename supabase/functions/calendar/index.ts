// 讀行事曆：
//   mode 'company'（預設）：公司行事曆 COMPANY_CALENDAR_ID
//   mode 'members'：夥伴分享給服務帳號的個人行事曆。分享「完整內容」回傳行程標題；只分享「忙碌／有空」只回傳時段。
// 正職、實習、主管看得到大家的；委外只看得到自己的。
import { cors, json } from '../_shared/slack.ts';
import { googleToken } from '../_shared/google.ts';
import { memberClient } from '../_shared/auth.ts';

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

const toLocal = (iso: string) => new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const who = await memberClient(req);
  if (!who) return json({ ok: false, error: 'not_member' }, 403);
  let q: { from?: string; to?: string; mode?: string; ids?: string[] } = {};
  try { q = await req.json(); } catch { /* 預設 */ }
  const from = dOk(q.from) || new Date().toISOString().slice(0, 10);
  const to = dOk(q.to) || new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);

  try {
    const token = await googleToken(SCOPE);

    if (q.mode === 'members') {
      const { data: staff } = await who.sb.rpc('is_staff');
      const { data: rows } = await who.sb.from('members').select('id,data');
      let ms = (rows ?? []).filter((r) => r.data?.active !== false);
      if (!staff) ms = ms.filter((r) => r.id === who.mid);
      if (Array.isArray(q.ids) && q.ids.length) ms = ms.filter((r) => q.ids!.includes(r.id));
      const key = 'm:' + (staff ? 'all' : who.mid) + from + to + ms.map((r) => r.id).join(',');
      const hit = memo.get(key);
      if (hit && Date.now() - hit.at < 120_000) return json(hit.body);

      const out: Record<string, { status: string; events: Ev[] }> = {};
      const needFb: { mid: string; cal: string }[] = [];
      await Promise.all(ms.map(async (r) => {
        const cal = String(r.data?.calendarId || '').trim();
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
      const body = { ok: true, members: out };
      memo.set(key, { at: Date.now(), body });
      return json(body);
    }

    const cal = Deno.env.get('COMPANY_CALENDAR_ID') || 'vwsi.campmanagement@gmail.com';
    const key = 'c:' + cal + from + to;
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < 120_000) return json(hit.body);
    const { status, j } = await listEvents(token, cal, from, to);
    if (status !== 200) return json({ ok: false, error: status === 404 || status === 403 ? 'not_shared' : 'google_error', detail: j?.error?.message }, 502);
    const events = (j.items ?? []).filter((e: { status?: string }) => e.status !== 'cancelled').map((e: Record<string, unknown>) => ({
      summary: e.summary, start: e.start, end: e.end, location: e.location, htmlLink: e.htmlLink,
    }));
    const body = { ok: true, events };
    memo.set(key, { at: Date.now(), body });
    return json(body);
  } catch (e) {
    return json({ ok: false, error: (e as { code?: string }).code || 'error', detail: String((e as Error).message).slice(0, 200) }, 500);
  }
});
