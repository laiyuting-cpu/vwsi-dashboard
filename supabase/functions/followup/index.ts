// 每個工作日早上由 GitHub Actions 呼叫：找出「等待他人／等待主管決策／卡關」且已到下次追蹤日的任務，發 Slack 提醒。
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { postSlack, json } from '../_shared/slack.ts';

const PENDING: Record<string, string> = { wait: '等待他人完成', decide: '等待主管決策', blocked: '卡關' };

function taipeiToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ ok: false, error: 'forbidden' }, 403);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const today = taipeiToday();

  const [{ data: tasks }, { data: projects }, { data: depts }, { data: members }] = await Promise.all([
    sb.from('tasks').select('id,data').in('data->>status', Object.keys(PENDING)).lte('data->>nextFollow', today),
    sb.from('projects').select('id,data'),
    sb.from('depts').select('id,data'),
    sb.from('members').select('id,data'),
  ]);
  const P = Object.fromEntries((projects ?? []).map((r) => [r.id, r.data]));
  const D = Object.fromEntries((depts ?? []).map((r) => [r.id, r.data]));
  const M = Object.fromEntries((members ?? []).map((r) => [r.id, r.data]));
  const tag = (id?: string) => (id && M[id] ? (M[id].slackId ? `<@${M[id].slackId}>` : M[id].name) : '負責人');

  const results: unknown[] = [];
  for (const { id, data: t } of tasks ?? []) {
    if (!t.nextFollow || t.followNotified === t.nextFollow) continue;
    const p = P[t.projectId] ?? {};
    if (p.status === 'archived') continue;
    const channel = p.slackChannel || D[p.dept]?.slackChannel;
    if (!channel) { results.push({ id, skipped: 'no_channel' }); continue; }
    const text = `⏰ *Pending 追蹤提醒*｜${tag(t.owner)}\n「${t.title}」（${p.name ?? ''}）已到追蹤日 ${t.nextFollow}，目前「${PENDING[t.status]}」${t.waitingOn ? '：' + t.waitingOn : ''}\n請更新狀態或下次追蹤日。`;
    const r = await postSlack(channel, text);
    if (r.ok) await sb.rpc('doc_patch', { tbl: 'tasks', doc_id: id, patch: { followNotified: t.nextFollow } });
    results.push({ id, ...r });
  }
  return json({ ok: true, today, sent: results });
});
