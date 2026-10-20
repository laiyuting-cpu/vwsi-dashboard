// 工作台按下按鈕時呼叫：插隊、等待主管決策。
// 只有名單上的夥伴能呼叫，而且只能發到部門頻道、專案頻道或 #general。
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { postSlack, cors, json } from '../_shared/slack.ts';

const GENERAL = 'C01N8DC3544';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+\.\S+\.\S+$/.test(auth)) return json({ ok: false, error: 'not_signed_in' }, 401);
  const key = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  // 用呼叫者自己的登入憑證查資料，資料庫權限規則照樣生效
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, key, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: mid, error: me } = await sb.rpc('my_member_id');
  if (me || !mid) return json({ ok: false, error: 'not_member' }, 403);

  let body: { channel?: string; text?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const channel = String(body.channel ?? '').trim();
  const text = String(body.text ?? '').slice(0, 3500);
  if (!channel || !text) return json({ ok: false, error: 'missing_fields' }, 400);

  // 呼叫者看得到的部門與專案頻道（受資料庫權限規則限制）
  const allowed = new Set<string>([GENERAL]);
  const [{ data: depts }, { data: projects }] = await Promise.all([
    sb.from('depts').select('data'),
    sb.from('projects').select('data'),
  ]);
  for (const r of [...(depts ?? []), ...(projects ?? [])]) {
    const c = (r as { data: { slackChannel?: string } }).data?.slackChannel;
    if (c) allowed.add(c);
  }
  if (!allowed.has(channel)) return json({ ok: false, error: 'channel_not_allowed' }, 403);

  const r = await postSlack(channel, text);
  return json(r, r.ok ? 200 : 502);
});
