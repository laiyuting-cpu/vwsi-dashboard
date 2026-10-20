// 用公司的 Slack 機器人發訊息。金鑰放在 Supabase 的 Edge Function Secrets：SLACK_BOT_TOKEN
export async function postSlack(channel: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const token = Deno.env.get('SLACK_BOT_TOKEN');
  if (!token) return { ok: false, error: 'missing_token' };
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'bad_response' }));
  return { ok: !!j.ok, error: j.error };
}

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export async function slackGet(method: string, params: Record<string, string>) {
  const token = Deno.env.get('SLACK_BOT_TOKEN');
  if (!token) return { ok: false, error: 'missing_token' } as Record<string, unknown>;
  const u = new URL('https://slack.com/api/' + method);
  u.search = new URLSearchParams(params).toString();
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json().catch(() => ({ ok: false, error: 'bad_response' }))) as Record<string, unknown>;
}

export const GENERAL = 'C01N8DC3544';
export const SITE = 'https://laiyuting-cpu.github.io/vwsi-dashboard/';
