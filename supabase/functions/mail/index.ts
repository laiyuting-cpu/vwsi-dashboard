// 公用信箱未讀提醒。
//   mode 'status'                    OAuth 是否設定好
//   mode 'connect'   { code }        （管理員）用 Google 授權碼連結一個信箱（gmail.readonly）
//   mode 'disconnect'{ id }          （管理員）取消連結並刪掉資料
//   mode 'refresh'                   （任何夥伴）立刻檢查一次自己看得到的信箱
//   mode 'poll'      （排程，每 5 分鐘）檢查全部信箱，並把新信用 Slack 私訊給看得到、沒靜音的夥伴
// 只保存近 7 天未讀信件的寄件人、主旨、摘要；讀過或過期就刪掉。
import { cors, json, postSlack, SITE } from '../_shared/slack.ts';
import { memberClient } from '../_shared/auth.ts';
import { encrypt, decrypt } from '../_shared/crypt.ts';
import { decodeBase64 } from '../_shared/b64.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const PURPOSE = 'vwsi-mailtoken';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GM = 'https://gmail.googleapis.com/gmail/v1/users/me';
const svc = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CID = () => Deno.env.get('GOOGLE_OAUTH_CLIENT_ID') || '';
const CSEC = () => Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET') || '';
const fail = (code: string, detail?: string, status = 400) => Object.assign(new Error(detail || code), { code, status });

type Box = { id: string; data: Record<string, any> };

async function accessToken(mb: string) {
  const { data: row } = await svc().rpc('mailtoken_get', { p_mb: mb });
  if (!row) throw fail('not_connected');
  const refresh = await decrypt(PURPOSE, row.enc);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CID(), client_secret: CSEC(), refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw fail(j.error === 'invalid_grant' ? 'reauth' : 'google_auth', JSON.stringify(j).slice(0, 200));
  return j.access_token as string;
}

const hdr = (m: any, name: string) => ((m.payload?.headers ?? []) as { name: string; value: string }[]).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function parseFrom(v: string) {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2], addr: m[2].trim() };
  return { name: v.trim(), addr: v.trim() };
}
const decodeEntities = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// 用 Gemini 判斷哪些是廣告／行銷／電子報（回傳要略過的 id）。失敗時回傳 null，下次再判斷。
const GKEY = () => Deno.env.get('GEMINI_API_KEY') || '';
const GMODELS = () => (Deno.env.get('GEMINI_MODEL') || 'gemini-flash-latest,gemini-2.5-flash').split(',').map((x) => x.trim()).filter(Boolean);
type Cand = { id: string; from: string; addr: string; subject: string; snippet: string; bulk: boolean };
async function findAds(cs: Cand[]): Promise<Set<string> | null> {
  if (!cs.length) return new Set();
  if (!GKEY()) return null;
  const prompt = '以下是一家台灣青少年職涯教育公司公用信箱的未讀信。請挑出「廣告、行銷、促銷、電子報、活動宣傳、社群平台推播、求職網站配對推薦、徵才廣告、優惠或會員回饋」這類不需要同事處理的信。\n' +
    '要保留（不要挑）的：真人寄來的信、客戶／家長／合作單位／學校／政府機關的往來、報名或訂單通知、付款／帳單／發票、帳號安全警示、退信通知、會議邀請、需要回覆或處理的事情。拿不準就保留。\n' +
    'bulk=true 代表信件有「取消訂閱」標頭，通常是群發信，但仍要看內容判斷。\n\n' + JSON.stringify(cs.map((c, i) => ({ i, from: c.from, addr: c.addr, subject: c.subject, snippet: c.snippet.slice(0, 140), bulk: c.bulk })));
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { ads: { type: 'ARRAY', items: { type: 'INTEGER' } } }, required: ['ads'] } } };
  for (const model of GMODELS()) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GKEY() }, body: JSON.stringify(body) });
      const j = await r.json();
      const t = j.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('');
      if (!t) continue;
      const ads: number[] = JSON.parse(t).ads ?? [];
      return new Set(ads.filter((i) => cs[i]).map((i) => cs[i].id));
    } catch { /* 換下一個模型 */ }
  }
  return null;
}

// 檢查一個信箱：更新未讀數、新增新信、刪掉已讀或過期的
async function pollBox(b: Box, first = false) {
  const db = svc();
  const now = new Date().toISOString();
  try {
    const tok = await accessToken(b.id);
    const H = { Authorization: `Bearer ${tok}` };
    const lab = await (await fetch(`${GM}/labels/INBOX`, { headers: H })).json();
    const list = await (await fetch(`${GM}/messages?` + new URLSearchParams({ q: 'is:unread in:inbox category:primary newer_than:7d', maxResults: '30' }), { headers: H })).json();
    if (list.error) throw fail(list.error.status === 'UNAUTHENTICATED' ? 'reauth' : 'gmail_error', list.error.message);
    const ids: string[] = (list.messages ?? []).map((m: { id: string }) => m.id);
    const { data: have } = await db.from('mail_msgs').select('id').eq('mailbox', b.id);
    const haveSet = new Set((have ?? []).map((r) => r.id));
    const gone = [...haveSet].filter((id) => !ids.includes(id));
    if (gone.length) await db.from('mail_msgs').delete().eq('mailbox', b.id).in('id', gone);
    const skip = new Set<string>((b.data?.skip ?? []).filter((id: string) => ids.includes(id)));
    const redo = b.data?.adv !== 1; // 還沒用過廣告過濾的信箱：已有的信也重新判斷一次
    const fresh = ids.filter((id) => (redo || !haveSet.has(id)) && !skip.has(id)).slice(0, 30);
    const rows = (await Promise.all(fresh.map(async (id) => {
      const m = await (await fetch(`${GM}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence`, { headers: H })).json();
      if (m.error) return null;
      const f = parseFrom(hdr(m, 'From'));
      return {
        mailbox: b.id, id, thread: m.threadId, from_name: f.name.slice(0, 120), from_addr: f.addr.slice(0, 200),
        subject: (hdr(m, 'Subject') || '（無主旨）').slice(0, 300), snippet: decodeEntities(String(m.snippet || '')).slice(0, 200),
        at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : now, notified: first || haveSet.has(id),
        _bulk: !!hdr(m, 'List-Unsubscribe') || /bulk|list/i.test(hdr(m, 'Precedence')),
      };
    }))).filter(Boolean) as Record<string, any>[];
    const ads = await findAds(rows.map((r) => ({ id: r.id, from: r.from_name, addr: r.from_addr, subject: r.subject, snippet: r.snippet, bulk: r._bulk })));
    if (ads) ads.forEach((id) => skip.add(id));
    // Gemini 暫時判斷不了時，先不顯示群發信，下次再判斷
    const keep = rows.filter((r) => ads ? !ads.has(r.id) : !r._bulk).map(({ _bulk, ...r }) => r);
    if (keep.length) await db.from('mail_msgs').upsert(keep);
    // 之前判斷錯而留下的（例如舊資料）也一併清掉
    const oldAds = [...haveSet].filter((id) => skip.has(id));
    if (oldAds.length) await db.from('mail_msgs').delete().eq('mailbox', b.id).in('id', oldAds);
    await db.rpc('doc_patch', { tbl: 'mailboxes', doc_id: b.id, patch: { status: 'ok', error: null, unread: Number(lab.messagesUnread ?? ids.length), checkedAt: now, skip: [...skip], ...(ads ? { adv: 1 } : {}) } });
    return { id: b.id, ok: true, added: keep.length, ads: ads?.size ?? null };
  } catch (e) {
    const code = (e as { code?: string }).code || 'error';
    await db.rpc('doc_patch', { tbl: 'mailboxes', doc_id: b.id, patch: { status: code === 'reauth' ? 'reauth' : 'error', error: String((e as Error).message).slice(0, 200), checkedAt: now } });
    return { id: b.id, ok: false, error: code };
  }
}

// Slack 私訊：每個人只收到看得到、沒靜音的信箱的新信
async function notify() {
  const db = svc();
  const tp = new Date(Date.now() + 8 * 3600_000).getUTCHours();
  if (tp >= 22 || tp < 8) return 0; // 晚上不打擾，早上一起補發
  const { data: fresh } = await db.from('mail_msgs').select('*').eq('notified', false).order('at');
  if (!fresh?.length) return 0;
  const [{ data: boxes }, { data: members }, { data: mutes }] = await Promise.all([
    db.from('mailboxes').select('id,data'), db.from('members').select('id,data'), db.from('mail_mutes').select('mid,mailbox'),
  ]);
  const muted = new Set((mutes ?? []).map((x) => x.mid + '|' + x.mailbox));
  const boxMap = new Map((boxes ?? []).map((b) => [b.id, b.data]));
  let sent = 0;
  for (const m of members ?? []) {
    const d = m.data || {};
    if (d.active === false || !d.slackId) continue;
    const admin = d.kind === '主管';
    const mine = fresh.filter((r) => {
      const bd = boxMap.get(r.mailbox); if (!bd || muted.has(m.id + '|' + r.mailbox)) return false;
      return bd.private ? bd.owner === m.id : admin || (bd.allow ?? []).includes(m.id);
    });
    if (!mine.length) continue;
    const by = new Map<string, typeof mine>();
    mine.forEach((r) => by.set(r.mailbox, [...(by.get(r.mailbox) ?? []), r]));
    const lines = [`✉️ 有 ${mine.length} 封新信`];
    for (const [mb, rs] of by) {
      lines.push('', `*${boxMap.get(mb)?.label || mb}*（${mb}）`);
      rs.slice(0, 8).forEach((r) => lines.push(`• ${r.from_name}：${r.subject}`));
      if (rs.length > 8) lines.push(`…還有 ${rs.length - 8} 封`);
    }
    lines.push('', `<${SITE}#overview|在工作台查看>　不想收到某個信箱的通知，可以在工作台的 ✉️ 按「靜音」`);
    const r = await postSlack(d.slackId, lines.join('\n'));
    if (r.ok) sent++;
  }
  await db.from('mail_msgs').update({ notified: true }).in('id', fresh.map((r) => r.id));
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const db = svc();
  const cronKey = req.headers.get('x-cron-secret');
  if (cronKey) {
    const { data: ok } = await db.rpc('check_cron_secret', { s: cronKey });
    if (!ok) return json({ ok: false, error: 'forbidden' }, 403);
    const { data: boxes } = await db.from('mailboxes').select('id,data');
    const res = await Promise.all((boxes ?? []).filter((b) => b.data?.status !== 'reauth').map((b) => pollBox(b)));
    const sent = await notify();
    return json({ ok: true, polled: res, sent });
  }
  const who = await memberClient(req);
  if (!who) return json({ ok: false, error: 'not_member' }, 403);
  let q: Record<string, any> = {};
  try { q = await req.json(); } catch { /* */ }
  const { data: isAdmin } = await who.sb.rpc('is_admin');
  try {
    if (q.mode === 'status') return json({ ok: true, clientId: CID(), ready: !!(CID() && CSEC()), admin: !!isAdmin });

    if (q.mode === 'connect') {
      if (!isAdmin) throw fail('admin_only', '', 403);
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: String(q.code || ''), client_id: CID(), client_secret: CSEC(), redirect_uri: 'postmessage', grant_type: 'authorization_code' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.access_token) throw fail('exchange_failed', JSON.stringify(j).slice(0, 200));
      if (!String(j.scope || '').includes(SCOPE)) throw fail('scope_missing');
      if (!j.refresh_token) throw fail('no_refresh');
      let email = '';
      try { const p = j.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); email = JSON.parse(new TextDecoder().decode(decodeBase64(p.padEnd(Math.ceil(p.length / 4) * 4, '=')))).email || ''; } catch { /* */ }
      email = email.toLowerCase();
      if (!email) throw fail('no_email');
      await db.rpc('mailtoken_put', { p_mb: email, p_enc: await encrypt(PURPOSE, j.refresh_token), p_scope: j.scope });
      const { data: old } = await db.from('mailboxes').select('id,data').eq('id', email).maybeSingle();
      const data = { ...(old?.data ?? { email, label: email.split('@')[0], allow: [], private: false, owner: who.mid }), status: 'ok', error: null, connectedAt: new Date().toISOString(), connectedBy: who.mid };
      await db.from('mailboxes').upsert({ id: email, data, updated_at: new Date().toISOString() });
      // 第一次連結時，現有的未讀信不發 Slack，免得一次跳出一堆
      const p = await pollBox({ id: email, data }, !old);
      return json({ ok: true, email, poll: p });
    }

    if (q.mode === 'disconnect') {
      if (!isAdmin) throw fail('admin_only', '', 403);
      const id = String(q.id || '').toLowerCase();
      const { data: row } = await db.rpc('mailtoken_get', { p_mb: id });
      if (row) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(await decrypt(PURPOSE, row.enc)), { method: 'POST' }); } catch { /* */ } }
      await db.rpc('mailtoken_del', { p_mb: id });
      await db.from('mailboxes').delete().eq('id', id);
      return json({ ok: true });
    }

    if (q.mode === 'refresh') {
      // 用呼叫者的權限列出看得到的信箱；1 分鐘內檢查過的就略過
      const { data: boxes } = await who.sb.from('mailboxes').select('id,data');
      const due = (boxes ?? []).filter((b) => b.data?.status !== 'reauth' && Date.now() - new Date(b.data?.checkedAt || 0).getTime() > 60_000);
      const res = await Promise.all(due.map((b) => pollBox(b)));
      return json({ ok: true, polled: res });
    }

    return json({ ok: false, error: 'bad_mode' }, 400);
  } catch (e) {
    const err = e as { code?: string; status?: number; message?: string };
    return json({ ok: false, error: err.code || 'error', detail: String(err.message || '').slice(0, 300) }, err.status || 500);
  }
});
