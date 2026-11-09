// deno-lint-ignore-file no-explicit-any
// 請假／遠距每日整理：每個工作日早上由 Supabase 排程（pg_cron）呼叫，發到 Slack #attendance-apply
//   今天誰請假、遠距、外出，以及接下來 7 天的登記
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { postSlack, slackGet, json, SITE } from '../_shared/slack.ts';

const CHANNEL = 'C06491MLQH3'; // #attendance-apply
const TYPES: Record<string, string> = { leave: '🌴 請假', remote: '🏠 遠距辦公', comp: '🛋️ 調休／補休', out: '🚐 外出／帶營', early: '⏰ 提早離開／晚到', other: '📌 其他' };
const WD = ['日', '一', '二', '三', '四', '五', '六'];
function taipeiToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${WD[new Date(d + 'T00:00:00Z').getUTCDay()]}）`;
function when(x: any): string {
  if (x.part === 'am') return '上午';
  if (x.part === 'pm') return '下午';
  if (x.part === 'time' && (x.from || x.to)) return `${x.from || ''}–${x.to || ''}`;
  return '全天';
}

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: okSecret } = await sb.rpc('check_cron_secret', { s: req.headers.get('x-cron-secret') ?? '' });
  if (!okSecret) return json({ ok: false, error: 'forbidden' }, 403);
  let opt: { dry?: boolean } = {};
  try { opt = await req.json(); } catch { /* */ }
  const today = taipeiToday(), until = addDays(today, 7);
  const [{ data: rows }, { data: members }] = await Promise.all([sb.from('leaves').select('id,data'), sb.from('members').select('id,data')]);
  const M: Record<string, any> = Object.fromEntries((members ?? []).map((r) => [r.id, r.data]));
  const all = (rows ?? []).map((r) => r.data).filter((x: any) => x.start && M[x.memberId] && (x.end || x.start) >= today && x.start <= until);
  const line = (x: any, withDate = false) => {
    const range = withDate ? (x.start === (x.end || x.start) ? md(x.start) : `${md(x.start)}–${md(x.end)}`) + ' ' : '';
    return `• ${range}${TYPES[x.type] || TYPES.other}｜*${M[x.memberId].name}*｜${when(x)}${x.note ? `｜${x.note}` : ''}`;
  };
  const now = all.filter((x: any) => x.start <= today).sort((a: any, b: any) => (a.type || '').localeCompare(b.type || ''));
  const next = all.filter((x: any) => x.start > today).sort((a: any, b: any) => a.start.localeCompare(b.start));
  if (!now.length && !next.length) return json({ ok: true, skipped: 'nothing', today });
  const parts = [`🗓️ *${md(today)} 出勤狀況*`];
  parts.push(now.length ? '*今天*\n' + now.map((x: any) => line(x, (x.end || x.start) > today)).join('\n') : '*今天* 大家都在崗位上 👍');
  if (next.length) parts.push('*接下來 7 天*\n' + next.map((x: any) => line(x, true)).join('\n'));
  parts.push(`👉 <${SITE}#leave|到工作台登記請假／遠距>`);
  const text = parts.join('\n\n');
  if (opt.dry) return json({ ok: true, dry: true, text });
  let r = await postSlack(CHANNEL, text);
  if (!r.ok && r.error === 'not_in_channel') { await slackGet('conversations.join', { channel: CHANNEL }); r = await postSlack(CHANNEL, text); }
  return json({ ok: r.ok, error: r.error, today, count: all.length });
});
