// 讀公司行事曆（COMPANY_CALENDAR_ID）。行事曆要先分享給服務帳號，權限「查看所有活動詳細資料」。
import { cors, json } from '../_shared/slack.ts';
import { googleToken } from '../_shared/google.ts';
import { memberClient } from '../_shared/auth.ts';

const memo = new Map<string, { at: number; body: unknown }>();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const who = await memberClient(req);
  if (!who) return json({ ok: false, error: 'not_member' }, 403);
  let q: { from?: string; to?: string } = {};
  try { q = await req.json(); } catch { /* 預設兩週 */ }
  const d = (s?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') ? s! : '');
  const from = d(q.from) || new Date().toISOString().slice(0, 10);
  const to = d(q.to) || new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const cal = Deno.env.get('COMPANY_CALENDAR_ID') || 'vwsi.campmanagement@gmail.com';
  const key = cal + from + to;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 120_000) return json(hit.body);
  try {
    const token = await googleToken('https://www.googleapis.com/auth/calendar.readonly');
    const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events`);
    u.search = new URLSearchParams({ timeMin: `${from}T00:00:00+08:00`, timeMax: `${to}T23:59:59+08:00`, singleEvents: 'true', orderBy: 'startTime', maxResults: '100', timeZone: 'Asia/Taipei' }).toString();
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!r.ok) return json({ ok: false, error: r.status === 404 || r.status === 403 ? 'not_shared' : 'google_error', detail: j?.error?.message }, 502);
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
