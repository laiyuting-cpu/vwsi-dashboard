// 列出機器人看得到的 Slack 頻道（公開頻道全部；私人頻道要先 /invite @職掘工作台）
// 需要機器人權限：channels:read、groups:read
import { cors, json, slackGet } from '../_shared/slack.ts';
import { memberClient } from '../_shared/auth.ts';

let memo: { at: number; body: unknown } | null = null;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const who = await memberClient(req);
  if (!who) return json({ ok: false, error: 'not_member' }, 403);
  let force = false;
  try { force = !!(await req.json()).force; } catch { /* */ }
  if (!force && memo && Date.now() - memo.at < 600_000) return json(memo.body);
  const out: { id: string; name: string; private: boolean; member: boolean }[] = [];
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const j = await slackGet('conversations.list', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000', ...(cursor ? { cursor } : {}) });
    if (!j.ok) return json({ ok: false, error: j.error, needed: j.needed }, 502);
    for (const c of (j.channels as Record<string, unknown>[]) ?? []) {
      out.push({ id: String(c.id), name: String(c.name), private: !!c.is_private, member: !!c.is_member });
    }
    cursor = String((j.response_metadata as { next_cursor?: string })?.next_cursor ?? '');
    if (!cursor) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  const body = { ok: true, channels: out };
  memo = { at: Date.now(), body };
  return json(body);
});
