// deno-lint-ignore-file no-explicit-any
// 聖誕交換禮物：由 GitHub Actions 排程呼叫（x-cron-secret）
//   action=remind：私訊還沒填願望的參加者，並在 #general 提醒
//   action=draw  ：抽籤（一個大循環，不會兩人互抽），結果只私訊給抽的人，存在 gift_draws（每人只看得到自己的）
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { postSlack, json, GENERAL, SITE } from '../_shared/slack.ts';

const LINK = SITE + '#gift';
function taipeiToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const b = new Uint32Array(1); crypto.getRandomValues(b);
    const j = b[0] % (i + 1); [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ ok: false, error: 'forbidden' }, 403);
  let opt: { action?: string; dry?: boolean; force?: boolean } = {};
  try { opt = await req.json(); } catch { /* */ }
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const today = taipeiToday();

  const { data: cfgRow } = await sb.from('gifts').select('data').eq('id', 'config').maybeSingle();
  const cfg: any = cfgRow?.data;
  if (!cfg) return json({ ok: false, error: 'no_config' });
  if (String(cfg.year) !== today.slice(0, 4) && !opt.force) return json({ ok: true, skipped: 'other_year' });

  const [{ data: members }, { data: wishes }] = await Promise.all([
    sb.from('members').select('id,data'),
    sb.from('gifts').select('id,data').neq('id', 'config'),
  ]);
  const M: Record<string, any> = Object.fromEntries((members ?? []).map((r) => [r.id, r.data]));
  const W: Record<string, any> = Object.fromEntries((wishes ?? []).map((r) => [r.id, r.data]));
  const ids: string[] = (cfg.participants ?? []).filter((id: string) => M[id] && M[id].active !== false);
  const send = (ch: string, text: string) => (opt.dry ? Promise.resolve({ ok: true, dry: true } as any) : postSlack(ch, text));
  const filled = (id: string) => !!(W[id] && W[id].wish);

  if (opt.action === 'remind') {
    if (cfg.drawn) return json({ ok: true, skipped: 'already_drawn' });
    const missing = ids.filter((id) => !filled(id));
    const out: unknown[] = [];
    for (const id of missing) {
      if (!M[id].slackId) { out.push({ id, error: 'no_slack' }); continue; }
      const r = await send(M[id].slackId, `🎄 聖誕交換禮物 *${md(cfg.drawAt)}（一）早上自動抽籤*！\n你還沒留下願望，花 1 分鐘用三個形容詞告訴聖誕老人你想收到什麼吧 🎁（禮物金額 200–400 元）\n👉 <${LINK}|到工作台填寫>`);
      out.push({ id, ok: r.ok, error: r.error });
    }
    const g = await send(GENERAL, `🎄 *聖誕交換禮物* 開放留言中！${ids.length} 位夥伴參加（禮物金額 200–400 元），目前 ${ids.length - missing.length} 人已經留下願望。\n${md(cfg.drawAt)}（一）早上 9 點自動抽籤，結果會私訊給你 🤫 👉 <${LINK}|到工作台留言>`);
    return json({ ok: true, today, missing: missing.length, dms: out, general: g.ok });
  }

  if (opt.action === 'draw') {
    if (cfg.drawn && !opt.force) return json({ ok: true, skipped: 'already_drawn' });
    if (!opt.force && today < cfg.drawAt) return json({ ok: true, skipped: 'too_early', drawAt: cfg.drawAt });
    if (ids.length < 2) return json({ ok: false, error: 'not_enough_people' });
    const order = shuffle(ids);
    const pairs = order.map((g, i) => ({ giver: g, receiver: order[(i + 1) % order.length] }));
    if (opt.dry) return json({ ok: true, dry: true, people: ids.length, cycle: pairs.every((p) => p.giver !== p.receiver) });
    const at = new Date().toISOString();
    await sb.from('gift_draws').delete().neq('id', '');
    const { error } = await sb.from('gift_draws').insert(pairs.map((p) => ({ id: 'draw_' + p.giver, data: { ...p, year: cfg.year, at } })));
    if (error) return json({ ok: false, error: error.message });
    await sb.from('gifts').update({ data: { ...cfg, drawn: true, drawnAt: at }, updated_at: at }).eq('id', 'config');
    const out: unknown[] = [];
    for (const p of pairs) {
      const giver = M[p.giver], rc = M[p.receiver], w = W[p.receiver] || {};
      if (!giver.slackId) { out.push({ id: p.giver, error: 'no_slack' }); continue; }
      const lines = [`🎅 *聖誕交換禮物抽籤結果*\n你是 *${rc.name}* 的神秘聖誕老人！記得保密喔 🤫`];
      if (w.wish) lines.push(`🎁 他用三個形容詞形容想要的禮物：*${w.wish}*`);
      if (w.avoid) lines.push(`🙅 請避開：${w.avoid}`);
      lines.push('💰 禮物金額 200–400 元');
      if (!w.wish) lines.push('他還沒留下願望，之後填了會出現在工作台。');
      lines.push(`👉 <${LINK}|到工作台看>`);
      const r = await postSlack(giver.slackId, lines.join('\n'));
      out.push({ id: p.giver, ok: r.ok, error: r.error });
    }
    const g = await postSlack(GENERAL, `🎄 *聖誕交換禮物抽籤完成！* ${ids.length} 位夥伴都收到私訊了，打開 Slack 私訊或 <${LINK}|工作台> 看看你抽到誰 🎁\n記得保密，聖誕節見 🎅`);
    return json({ ok: true, today, people: ids.length, dms: out, general: g.ok });
  }
  return json({ ok: false, error: 'unknown_action' });
});
