// 工作台按下按鈕時呼叫：插隊、等待主管決策。
// 只有名單上的夥伴能呼叫，而且只能發到部門頻道、專案頻道、#general，或私訊名單上的夥伴。
import { memberClient } from '../_shared/auth.ts';
import { postSlack, cors, json, GENERAL } from '../_shared/slack.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const who = await memberClient(req);
  if (!who) return json({ ok: false, error: 'not_member' }, 403);
  const sb = who.sb;

  let body: { channel?: string; text?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const channel = String(body.channel ?? '').trim();
  const text = String(body.text ?? '').slice(0, 3500);
  if (!channel || !text) return json({ ok: false, error: 'missing_fields' }, 400);

  // 呼叫者看得到的部門與專案頻道（受資料庫權限規則限制）
  const allowed = new Set<string>([GENERAL]);
  const [{ data: depts }, { data: projects }, { data: members }] = await Promise.all([
    sb.from('depts').select('data'),
    sb.from('projects').select('data'),
    sb.from('members').select('data'),
  ]);
  for (const r of [...(depts ?? []), ...(projects ?? [])]) {
    const c = (r as { data: { slackChannel?: string } }).data?.slackChannel;
    if (c) allowed.add(c);
  }
  // 私訊：只能發給名單上的夥伴
  for (const r of members ?? []) {
    const u = (r as { data: { slackId?: string; active?: boolean } }).data;
    if (u?.slackId && u.active !== false) allowed.add(u.slackId);
  }
  if (!allowed.has(channel)) return json({ ok: false, error: 'channel_not_allowed' }, 403);

  const r = await postSlack(channel, text);
  return json(r, r.ok ? 200 : 502);
});
