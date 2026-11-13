// 會議記錄：把錄音分段轉成逐字稿，最後整理重點、決議、待辦。
//   mode 'seg'      { id, n }  轉錄第 n 段（現場錄音：第 n 個音檔；上傳音檔：第 n 個 10 分鐘區間）
//   mode 'summary'  { id }     用全部逐字稿產生重點
//   mode 'status'              Gemini 金鑰是否設定好
//   mode 'cleanup'  （排程）   刪掉 30 天前的音檔，逐字稿保留
// 金鑰：Supabase Edge Function Secrets 的 GEMINI_API_KEY；模型可用 GEMINI_MODEL 覆寫（逗號分隔，依序嘗試）。
import { cors, json } from '../_shared/slack.ts';
import { memberClient } from '../_shared/auth.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { encodeBase64 } from '../_shared/b64.ts';

const WIN = 600; // 上傳音檔每 10 分鐘轉一段
const API = 'https://generativelanguage.googleapis.com';
const svc = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const KEY = () => Deno.env.get('GEMINI_API_KEY') || '';
const MODELS = () => (Deno.env.get('GEMINI_MODEL') || 'gemini-flash-latest,gemini-2.5-flash').split(',').map((s) => s.trim()).filter(Boolean);
const fail = (code: string, detail?: string) => Object.assign(new Error(detail || code), { code });

type Line = { t: number; sp: string; text: string };
type Part = { n: number; path: string; mime: string; dur?: number; off?: number };
type MData = {
  owner: string; title?: string; autoTitle?: boolean; date?: string; status?: string;
  file?: boolean; dur?: number; parts?: Part[]; gfile?: { uri: string; mime: string; exp: number; path: string };
  people?: string[]; vocab?: string; speakers?: Record<string, string>; shared?: string[];
  createdAt?: string; purged?: boolean;
};

const mmss = (s: number) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0'); };
const parseT = (v: string) => { const p = String(v || '').trim().split(':').map(Number); if (p.some(isNaN) || !p.length) return 0; return p.reduce((a, b) => a * 60 + b, 0); };
const geminiMime = (m: string) => { m = (m || '').split(';')[0].toLowerCase(); if (m === 'audio/x-m4a') return 'audio/mp4'; if (m === 'video/webm') return 'audio/webm'; if (m === 'audio/mpeg3' || m === 'audio/x-mp3') return 'audio/mp3'; return m || 'audio/webm'; };

async function gemini(parts: unknown[], schema: unknown, maxOut = 32768) {
  const key = KEY();
  if (!key) throw fail('missing_key');
  let last = '';
  for (const model of MODELS()) {
    const r = await fetch(`${API}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2, maxOutputTokens: maxOut },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 404) { last = `model ${model} not found`; continue; }
    if (r.status === 400 && /api key/i.test(j?.error?.message || '')) throw fail('bad_key', j.error.message);
    if (!r.ok) throw fail(r.status === 429 ? 'quota' : 'gemini_error', `${r.status} ${j?.error?.message || ''}`.slice(0, 300));
    const c = j.candidates?.[0];
    const text = (c?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text || '').join('');
    if (!text) throw fail('empty', c?.finishReason || j?.promptFeedback?.blockReason || 'no text');
    try { return JSON.parse(text); } catch { throw fail('bad_json', (c?.finishReason || '') + ' ' + text.slice(0, 120)); }
  }
  throw fail('no_model', last);
}

async function gUpload(bytes: Uint8Array<ArrayBuffer>, mime: string, name: string) {
  const key = KEY();
  if (!key) throw fail('missing_key');
  const s = await fetch(`${API}/upload/v1beta/files`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(bytes.length), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: name } }),
  });
  const url = s.headers.get('x-goog-upload-url');
  if (!url) throw fail('upload_failed', `${s.status} ${(await s.text()).slice(0, 200)}`);
  const u = await fetch(url, { method: 'POST', headers: { 'Content-Length': String(bytes.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: bytes });
  const j = await u.json().catch(() => ({}));
  let f = j.file;
  if (!f?.uri) throw fail('upload_failed', JSON.stringify(j).slice(0, 200));
  for (let i = 0; i < 40 && f.state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    f = await (await fetch(`${API}/v1beta/${f.name}`, { headers: { 'x-goog-api-key': key } })).json();
  }
  if (f.state === 'FAILED') throw fail('upload_failed', 'gemini file failed');
  return { uri: f.uri as string, mime: (f.mimeType as string) || mime };
}

async function download(path: string) {
  const { data, error } = await svc().storage.from('meetings').download(path);
  if (error || !data) throw fail('audio_missing', error?.message);
  return new Uint8Array(await data.arrayBuffer()) as Uint8Array<ArrayBuffer>;
}

const LINES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lines: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { t: { type: 'STRING' }, sp: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['t', 'sp', 'text'] },
    },
  },
  required: ['lines'],
};
const SUM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    points: { type: 'ARRAY', items: { type: 'STRING' } },
    decisions: { type: 'ARRAY', items: { type: 'STRING' } },
    todos: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, owner: { type: 'STRING' }, due: { type: 'STRING' } }, required: ['text', 'owner', 'due'] } },
    questions: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['title', 'points', 'decisions', 'todos', 'questions'],
};
const BASE_VOCAB = '職掘、島輝、I&I、Daily Mission、WBS、拇指園、營隊、引導員、場控、冬令營、夏令營、家扶、康軒';

async function memberNames() {
  const { data } = await svc().from('members').select('data');
  return (data ?? []).filter((r) => r.data?.active !== false).map((r) => String(r.data?.name || '')).filter(Boolean);
}

async function doSeg(id: string, m: MData, n: number) {
  const db = svc();
  const parts = m.parts ?? [];
  let audio: Record<string, unknown>;
  let range = '';
  let off = 0;
  if (m.file) {
    const p = parts[0];
    if (!p) throw fail('audio_missing');
    let g = m.gfile;
    if (!g || g.exp < Date.now() + 15 * 60_000 || g.path !== p.path) {
      const up = await gUpload(await download(p.path), geminiMime(p.mime), id);
      g = { ...up, exp: Date.now() + 46 * 3600_000, path: p.path };
      await db.rpc('doc_patch', { tbl: 'meetings', doc_id: id, patch: { gfile: g } });
    }
    audio = { fileData: { fileUri: g.uri, mimeType: g.mime } };
    const dur = Number(m.dur) || 0;
    if (dur > WIN + 60) {
      const s = n * WIN, e = Math.min(dur, (n + 1) * WIN);
      range = `只轉錄音檔中 ${mmss(s)} 到 ${mmss(e)} 之間的內容（其他時間不要輸出）。t 以整個音檔開頭為 0:00。`;
      off = s;
    } else range = '轉錄整個音檔。t 以音檔開頭為 0:00。';
  } else {
    const p = parts.find((x) => x.n === n);
    if (!p) throw fail('audio_missing');
    const bytes = await download(p.path);
    const mime = geminiMime(p.mime);
    if (bytes.length > 12 * 1024 * 1024) { const up = await gUpload(bytes, mime, id + '-' + n); audio = { fileData: { fileUri: up.uri, mimeType: up.mime } }; }
    else audio = { inlineData: { mimeType: mime, data: encodeBase64(bytes) } };
    range = '轉錄整段錄音。t 以這段錄音開頭為 0:00。';
    off = Number(p.off) || 0;
  }

  // 前一段的最後幾句與已用過的說話者標籤，讓整場會議的標籤一致
  const { data: prev } = await db.from('meeting_segs').select('n,lines,status').eq('meeting_id', id).lt('n', n).order('n');
  const done = (prev ?? []).filter((s) => s.status === 'done');
  const labels = [...new Set(done.flatMap((s) => (s.lines as Line[]).map((l) => l.sp)))].slice(0, 12);
  const tail = (done.at(-1)?.lines as Line[] | undefined)?.slice(-6).map((l) => `${l.sp}：${l.text}`).join('\n') || '';
  const people = [...new Set([...(m.people ?? [])])].filter(Boolean).join('、');

  const prompt = [
    '你是專業的會議逐字稿紀錄員。請把這段會議錄音完整轉成逐字稿。',
    range,
    '規則：',
    '- 使用繁體中文（台灣用語）。英文單字、品牌、專有名詞保留原文。',
    '- 忠實記錄說話內容，可以省略「嗯、呃、那個」等沒有意義的語助詞，但不要摘要或改寫。',
    '- 依說話者分段，每次換人說話就換一行。同一人連續講很久時，大約每 30 秒分一行。',
    '- sp 是說話者標籤。能從對話中確定是誰（例如被叫名字、自我介紹）就用姓名，否則用「說話者A」「說話者B」…。同一個人在整場會議要用同一個標籤。',
    labels.length ? `- 前面段落已使用的說話者標籤：${labels.join('、')}。同一個人請沿用。` : '',
    people ? `- 可能的與會者：${people}` : '',
    `- 可能出現的專有名詞：${[BASE_VOCAB, m.vocab].filter(Boolean).join('、')}`,
    '- t 是這一行開始說話的時間，格式 M:SS 或 H:MM:SS。',
    '- 沒有人說話的部分不要輸出；整段都沒有語音時 lines 回傳空陣列。',
    tail ? `前一段最後幾句（只供判斷說話者，不要重複輸出）：\n${tail}` : '',
  ].filter(Boolean).join('\n');

  const out = await gemini([audio, { text: prompt }], LINES_SCHEMA);
  let lines: Line[] = ((out?.lines ?? []) as { t: string; sp: string; text: string }[])
    .filter((l) => l && String(l.text || '').trim())
    .map((l) => ({ t: parseT(l.t), sp: String(l.sp || '說話者').trim().slice(0, 30), text: String(l.text).trim() }));
  if (m.file) {
    // 模型偶爾會用「區間開頭」當 0:00，這時補上位移
    if (off > 0 && lines.length && Math.max(...lines.map((l) => l.t)) < off - 5) lines = lines.map((l) => ({ ...l, t: l.t + off }));
  } else lines = lines.map((l) => ({ ...l, t: l.t + off }));
  return lines;
}

async function doSummary(id: string, m: MData) {
  const db = svc();
  const { data: segs } = await db.from('meeting_segs').select('n,lines,status').eq('meeting_id', id).order('n');
  const map = m.speakers ?? {};
  const all = (segs ?? []).filter((s) => s.status === 'done').flatMap((s) => s.lines as Line[]);
  if (!all.length) throw fail('no_transcript');
  const text = all.map((l) => `[${mmss(l.t)}] ${map[l.sp] || l.sp}：${l.text}`).join('\n');
  const names = await memberNames();
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const prompt = [
    '以下是一場會議的逐字稿。請用繁體中文（台灣用語）整理成會議紀錄。',
    `今天是 ${today}（會議日期 ${m.date || today}）。公司是「職掘」，一家青少年職涯探索教育公司。`,
    `公司夥伴名單：${names.join('、')}`,
    '輸出：',
    '- title：12 字以內的會議標題。',
    '- points：3～8 點重點，每點一句話，具體寫出討論了什麼、結論是什麼。',
    '- decisions：會議中明確做出的決定；沒有就回傳空陣列。',
    '- todos：會後要做的事。text 用動詞開頭；owner 填負責人姓名（盡量對應公司夥伴名單裡的名字，沒有明確負責人就空字串）；due 填 YYYY-MM-DD（有提到期限才填，「下週三」這類請換算成日期，沒有就空字串）。',
    '- questions：還沒有結論、需要再確認的事；沒有就回傳空陣列。',
    '不要編造逐字稿裡沒有的內容。',
    '',
    '逐字稿：',
    text,
  ].join('\n');
  return await gemini([{ text: prompt }], SUM_SCHEMA, 8192);
}

async function cleanup() {
  const db = svc();
  const cut = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data } = await db.from('meetings').select('id,data').lt('data->>createdAt', cut).limit(200);
  let n = 0;
  for (const r of data ?? []) {
    if (r.data?.purged) continue;
    const { data: files } = await db.storage.from('meetings').list(r.id, { limit: 1000 });
    const paths = (files ?? []).map((f) => `${r.id}/${f.name}`);
    if (paths.length) await db.storage.from('meetings').remove(paths);
    await db.rpc('doc_patch', { tbl: 'meetings', doc_id: r.id, patch: { purged: true, gfile: null } });
    n++;
  }
  return n;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const cronKey = req.headers.get('x-cron-secret');
  if (cronKey) {
    const { data: ok } = await svc().rpc('check_cron_secret', { s: cronKey });
    if (!ok) return json({ ok: false, error: 'forbidden' }, 403);
    try { return json({ ok: true, purged: await cleanup() }); } catch (e) { return json({ ok: false, error: String((e as Error).message) }, 500); }
  }
  const who = await memberClient(req);
  if (!who) return json({ ok: false, error: 'not_member' }, 403);
  let q: { mode?: string; id?: string; n?: number } = {};
  try { q = await req.json(); } catch { /* */ }
  if (q.mode === 'status') return json({ ok: true, ready: !!KEY() });

  const id = String(q.id || '');
  // 用呼叫者的權限讀，確定他看得到這場會議
  const { data: row } = await who.sb.from('meetings').select('id,data').eq('id', id).maybeSingle();
  if (!row) return json({ ok: false, error: 'not_found' }, 404);
  const m = row.data as MData;
  const db = svc();
  try {
    if (q.mode === 'seg') {
      const n = Math.max(0, Math.floor(Number(q.n) || 0));
      await db.from('meeting_segs').upsert({ meeting_id: id, n, status: 'working', error: null, updated_at: new Date().toISOString() });
      try {
        const lines = await doSeg(id, m, n);
        await db.from('meeting_segs').upsert({ meeting_id: id, n, status: 'done', lines, error: null, updated_at: new Date().toISOString() });
        return json({ ok: true, n, count: lines.length });
      } catch (e) {
        const code = (e as { code?: string }).code || 'error';
        await db.from('meeting_segs').upsert({ meeting_id: id, n, status: 'error', error: `${code}: ${String((e as Error).message).slice(0, 300)}`, updated_at: new Date().toISOString() });
        throw e;
      }
    }
    if (q.mode === 'summary') {
      const s = await doSummary(id, m);
      const patch: Record<string, unknown> = {
        summary: { points: s.points ?? [], decisions: s.decisions ?? [], todos: (s.todos ?? []).map((t: Record<string, string>) => ({ text: t.text, owner: t.owner || '', due: /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? t.due : '' })), questions: s.questions ?? [] },
        status: 'done', summarizedAt: new Date().toISOString(),
      };
      if (m.autoTitle && s.title) { patch.title = String(s.title).slice(0, 40); patch.autoTitle = false; }
      await db.rpc('doc_patch', { tbl: 'meetings', doc_id: id, patch });
      return json({ ok: true });
    }
    return json({ ok: false, error: 'bad_mode' }, 400);
  } catch (e) {
    const code = (e as { code?: string }).code || 'error';
    return json({ ok: false, error: code, detail: String((e as Error).message).slice(0, 300) }, code === 'missing_key' ? 503 : 500);
  }
});
