// deno-lint-ignore-file no-explicit-any
// 每個工作日早上由 GitHub Actions 呼叫：
//   1. Pending 追蹤提醒：等待他人／等待主管決策／卡關，且已到下次追蹤日 → 發到專案頻道（沒有就部門頻道、#general），tag 負責人
//   2. 每日到期清單：私訊每位夥伴，列出自己今天到期與已逾期的任務
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { postSlack, json, GENERAL, SITE } from '../_shared/slack.ts';

const PENDING: Record<string, string> = { wait: '等待他人完成', decide: '等待主管決策', blocked: '卡關' };

function taipeiToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ ok: false, error: 'forbidden' }, 403);
  let opt: { only?: string; dry?: boolean } = {};
  try { opt = await req.json(); } catch { /* */ }
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const today = taipeiToday();

  const [{ data: tasks }, { data: projects }, { data: depts }, { data: members }] = await Promise.all([
    sb.from('tasks').select('id,data').neq('data->>status', 'done'),
    sb.from('projects').select('id,data'),
    sb.from('depts').select('id,data'),
    sb.from('members').select('id,data'),
  ]);
  const P: Record<string, any> = Object.fromEntries((projects ?? []).map((r) => [r.id, r.data]));
  const D: Record<string, any> = Object.fromEntries((depts ?? []).map((r) => [r.id, r.data]));
  const M: Record<string, any> = Object.fromEntries((members ?? []).map((r) => [r.id, r.data]));
  const tag = (id?: string) => (id && M[id] ? (M[id].slackId ? `<@${M[id].slackId}>` : M[id].name) : '負責人');
  const live = (tasks ?? []).filter(({ data: t }) => !t.phase && P[t.projectId] && P[t.projectId].status !== 'archived');
  const send = (ch: string, text: string) => (opt.dry ? Promise.resolve({ ok: true, dry: true }) : postSlack(ch, text));

  const pending: unknown[] = [];
  if (opt.only !== 'digest') {
    for (const { id, data: t } of live) {
      if (!PENDING[t.status] || !t.nextFollow || t.nextFollow > today || t.followNotified === t.nextFollow) continue;
      const p = P[t.projectId];
      const channel = p.slackChannel || D[p.dept]?.slackChannel || GENERAL;
      const text = `⏰ *Pending 追蹤提醒*｜${tag(t.owner)}\n「${t.title}」（${p.name ?? ''}）已到追蹤日 ${md(t.nextFollow)}，目前「${PENDING[t.status]}」${t.waitingOn ? '：' + t.waitingOn : ''}\n請更新狀態或下次追蹤日。`;
      const r = await send(channel, text);
      if (r.ok && !opt.dry) await sb.rpc('doc_patch', { tbl: 'tasks', doc_id: id, patch: { followNotified: t.nextFollow } });
      pending.push({ id, ...r });
    }
  }

  const digest: unknown[] = [];
  if (opt.only !== 'pending') {
    for (const [mid, m] of Object.entries(M)) {
      if (m.active === false || !m.slackId) continue;
      const mine = live.map((r) => r.data).filter((t) => t.owner === mid && t.due && t.due <= today).sort((a, b) => a.due.localeCompare(b.due));
      if (!mine.length) continue;
      const over = mine.filter((t) => t.due < today), due = mine.filter((t) => t.due === today);
      const line = (t: Record<string, string>) => `• ${t.title}（${P[t.projectId]?.name ?? ''}）${t.due < today ? `｜${md(t.due)} 到期` : ''}`;
      let text = `☀️ 早安 ${m.name}，這是你今天要注意的任務：`;
      if (due.length) text += `\n\n*今天到期 ${due.length} 項*\n` + due.slice(0, 10).map(line).join('\n');
      if (over.length) text += `\n\n*已逾期 ${over.length} 項*\n` + over.slice(0, 10).map(line).join('\n') + (over.length > 10 ? `\n…還有 ${over.length - 10} 項` : '');
      text += `\n\n<${SITE}#mine|打開我的任務>，完成了記得打勾，或更新期限。`;
      const r = await send(m.slackId, text);
      digest.push({ mid, n: mine.length, ...r });
    }
  }
  return json({ ok: true, today, pending, digest });
});
