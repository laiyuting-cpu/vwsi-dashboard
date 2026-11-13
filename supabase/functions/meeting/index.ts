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
  people?: string[]; vocab?: string; type?: string; speakers?: Record<string, string>; shared?: string[];
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
// 會議類型：每種類型整理成不同段落。todos＝下一步行動。
type TypeDef = { label: string; intro: string; sections: [string, string][]; todo: string };
const TYPES: Record<string, TypeDef> = {
  general: {
    label: '一般會議', intro: '這是一場內部會議。',
    sections: [['重點', '3～8 點，每點一句話，具體寫出討論了什麼、結論是什麼'], ['決議', '會議中明確做出的決定'], ['待確認', '還沒有結論、需要再確認的事']],
    todo: '會後要做的事',
  },
  partner: {
    label: '對外洽談', intro: '這是和客戶或合作單位的洽談會議。',
    sections: [['對方背景與需求', '對方是誰、想解決什麼、在意什麼'], ['我們提出的內容', '我方提出的方案、服務、報價'], ['對方回饋與疑慮', '對方的反應、顧慮、提出的條件'], ['共識與條件', '雙方同意的事；金額、日期、人數、場次等數字照原話寫，不要估算'], ['待確認', '還沒談定、需要再確認的事']],
    todo: '會後雙方要做的事（標明是我方還是對方）',
  },
  interview: {
    label: '面試', intro: '這是一場徵才面試。只整理事實與應徵者的原話重點，不要評斷是否錄取、不要推測個人隱私。',
    sections: [['應徵者背景與經歷', '學經歷、相關經驗'], ['回答重點', '依面試問題整理應徵者的回答'], ['亮點', '回答中具體展現的能力或經驗（要有對話依據）'], ['需要再確認的地方', '回答不清楚、前後不一致或還沒問到的部分'], ['後續安排', '面試中提到的時程、下一關、需要補的資料']],
    todo: '面試後要做的事（例如安排下一關、寄資料）；沒有提到就回傳空陣列',
  },
  brainstorm: {
    label: '腦力激盪', intro: '這是一場發想討論會議。',
    sections: [['提出的點子', '同類的點子合併，能判斷時標註是誰提出的'], ['大家傾向的方向', '討論中獲得較多支持的點子與理由'], ['需要驗證或研究', '還要查證、試做或找人確認的事']],
    todo: '會後要做的事',
  },
  oneonone: {
    label: '1 對 1', intro: '這是一場主管與夥伴的 1 對 1 面談。語氣保持中性，不要推測情緒或健康狀況。',
    sections: [['近況與進度', '夥伴分享的工作近況'], ['討論重點', '這次聊到的主題與結論'], ['需要的支援', '夥伴提出需要的協助或資源'], ['共識', '雙方同意的做法']],
    todo: '會後雙方要做的事',
  },
};
const typeOf = (m: MData) => TYPES[m.type || ''] ? (m.type as string) : 'general';
function sumSchema(def: TypeDef) {
  const props: Record<string, unknown> = { title: { type: 'STRING' } };
  def.sections.forEach((_, i) => { props['s' + i] = { type: 'ARRAY', items: { type: 'STRING' } }; });
  props.todos = { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, owner: { type: 'STRING' }, due: { type: 'STRING' } }, required: ['text', 'owner', 'due'] } };
  return { type: 'OBJECT', properties: props, required: Object.keys(props) };
}
const BASE_VOCAB = '職掘、島輝、I&I、Daily Mission、WBS、拇指園、營隊、引導員、場控、冬令營、夏令營、家扶、康軒';

// 公司夥伴名單（從工作台成員自動帶入）。「小賴（Teresa）」會拆成「小賴／Teresa」兩個稱呼，aliases 欄位可再補暱稱。
async function memberNames() {
  const { data } = await svc().from('members').select('data');
  return (data ?? []).filter((r) => r.data?.active !== false && r.data?.name).map((r) => {
    const raw = String(r.data.name);
    const parts = raw.split(/[（）()、,，/／]/).map((x) => x.trim()).filter(Boolean);
    const extra = Array.isArray(r.data.aliases) ? r.data.aliases.map(String) : [];
    return [...new Set([...parts, ...extra])].join('／');
  });
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
  const team = (await memberNames()).join('、');

  const prompt = [
    '你是專業的會議逐字稿紀錄員。請把這段會議錄音完整轉成逐字稿。',
    range,
    '規則：',
    '- 使用繁體中文（台灣用語）。英文單字、品牌、專有名詞保留原文。',
    '- 忠實記錄說話內容，可以省略「嗯、呃、那個」等沒有意義的語助詞，但不要摘要或改寫。',
    '- 依說話者分段，每次換人說話就換一行。同一人連續講很久時，大約每 30 秒分一行。',
    '- sp 是說話者標籤。能從對話中確定是誰（例如被叫名字、自我介紹）就用姓名，否則用「說話者A」「說話者B」…。同一個人在整場會議要用同一個標籤。',
    labels.length ? `- 前面段落已使用的說話者標籤：${labels.join('、')}。同一個人請沿用。` : '',
    `- 職掘公司夥伴（對話中出現這些名字時請照這個寫法）：${team}`,
    people ? `- 這場會議的與會者：${people}` : '',
    m.type === 'interview' ? '- 這是一場面試，通常是面試官提問、應徵者回答；不知道應徵者姓名時用「應徵者」當標籤。' : '',
    m.type === 'partner' ? '- 這是和公司外部（客戶、合作單位）的會議；外部人士不知道姓名時用「對方A」「對方B」當標籤。' : '',
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
  const def = TYPES[typeOf(m)];
  const prompt = [
    `以下是一場會議的逐字稿。請用繁體中文（台灣用語）整理成會議紀錄。${def.intro}`,
    `今天是 ${today}（會議日期 ${m.date || today}）。公司是「職掘」，一家青少年職涯探索教育公司。`,
    `公司夥伴名單（斜線是同一個人的不同稱呼）：${names.join('、')}`,
    '輸出欄位：',
    '- title：12 字以內的會議標題。',
    ...def.sections.map(([h, d], i) => `- s${i}（${h}）：${d}。每點一句話；沒有就回傳空陣列。`),
    `- todos（下一步行動）：${def.todo}。text 用動詞開頭；owner 填負責人（公司夥伴請用名單裡斜線前的第一個名字，外部人士寫單位或稱呼，沒有明確負責人就空字串）；due 填 YYYY-MM-DD（有提到期限才填，「下週三」這類請換算成日期，沒有就空字串）。`,
    '不要編造逐字稿裡沒有的內容。',
    '',
    '逐字稿：',
    text,
  ].join('\n');
  const out = await gemini([{ text: prompt }], sumSchema(def), 8192);
  return { title: out.title, sections: def.sections.map(([h], i) => ({ h, items: (out['s' + i] ?? []).map(String).filter(Boolean) })), todos: out.todos ?? [], type: typeOf(m) };
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
        summary: { type: s.type, sections: s.sections, todos: (s.todos ?? []).map((t: Record<string, string>) => ({ text: t.text, owner: t.owner || '', due: /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? t.due : '' })) },
        todoState: {},
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
