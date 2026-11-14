// 會議記錄（錄音 → 逐字稿 → 重點）＋ 在工作台編輯自己的 Google 日曆
// 依賴 index.html 提供的 window.JJ（狀態與共用函式）。對外提供 window.JX。
(function () {
  'use strict';
  const SEG_SEC = 300;            // 現場錄音每 5 分鐘切一段，邊錄邊轉
  const WIN = 600;                // 上傳音檔每 10 分鐘轉一段（與後端一致）
  const MAX_UP = 50 * 1024 * 1024;
  const SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
  const J = () => window.JJ;
  const S = () => window.JJ.S;
  const esc = (s) => window.JJ.esc(s);
  const toast = (m) => window.JJ.toast(m);
  const me = () => window.JJ.me();

  // 會議類型（後端 meeting 函式有對應的整理格式）
  const TYPES = [['general', '一般會議', '重點、決議、待確認'], ['partner', '對外洽談', '對方需求、共識與條件'], ['interview', '面試', '背景、回答重點、待確認'], ['brainstorm', '腦力激盪', '點子、傾向方向'], ['oneonone', '1 對 1', '近況、需要的支援、共識'], ['lecture', '上課筆記', '大綱、重點觀念、案例、金句']];
  const todoLabel = (m) => (m && m.type === 'lecture' ? '應用與作業' : '下一步行動');
  const typeLabel = (t) => (TYPES.find((x) => x[0] === t) || TYPES[0])[1];
  function guessType(o) {
    const t = String((o && o.title) || '');
    if (/面試|interview/i.test(t)) return 'interview';
    if (/1\s*(對|on|:)\s*1|一對一/i.test(t)) return 'oneonone';
    if (/腦力激盪|發想|brainstorm/i.test(t)) return 'brainstorm';
    if (/上課|講座|演講|聽課|lecture/i.test(t)) return 'lecture';
    if (o && o.external) return 'partner';
    return 'general';
  }
  // 舊格式（points/decisions/questions）轉成段落
  function secs(sm) {
    if (!sm) return [];
    if (Array.isArray(sm.sections)) return sm.sections;
    return [['重點', sm.points], ['決議', sm.decisions], ['待確認', sm.questions]].map(([h, items]) => ({ h, items: items || [] }));
  }
  const M = { list: {}, sel: null, tab: 'sum', segs: {}, segSub: null, busy: {}, ready: null, rec: null, audioUrl: {}, tdProj: '', slackCh: '' };
  const G = { st: null, ev: null, cals: null, gis: null, modal: null };

  /* ---------- 小工具 ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + pad(m) : m) + ':' + pad(x); };
  const durTxt = (s) => { s = Math.round(s || 0); if (s < 60) return s + ' 秒'; const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return (h ? h + ' 小時 ' : '') + m + ' 分'; };
  const nowISO = () => new Date().toISOString();
  const localDate = () => J().today();
  const hm = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const isMob = () => matchMedia('(max-width:760px)').matches;
  async function call(fn, body) {
    try {
      const { data, error } = await S().sb.functions.invoke(fn, { body });
      let r = data;
      if (error) { try { r = await error.context.json(); } catch (_) { r = { ok: false, error: 'network' }; } }
      return r || { ok: false, error: 'empty' };
    } catch (e) { console.warn(e); return { ok: false, error: 'network' }; }
  }
  function host() {
    let h = document.getElementById('jxModal');
    if (!h) { h = document.createElement('div'); h.id = 'jxModal'; document.body.appendChild(h); }
    return h;
  }
  function closeModal() { stopTest(); G.modal = null; M.startOpts = null; host().innerHTML = ''; }
  function modal(title, body, foot) {
    host().innerHTML = '<div class="scrim" data-jx="close"></div><div class="modal jx-m" role="dialog" aria-label="' + esc(title) + '"><div style="display:flex;align-items:center;gap:8px"><h2 style="margin:0;flex:1">' + esc(title) + '</h2><button class="btn ghost" data-jx="close" aria-label="關閉">✕</button></div>' + body + (foot ? '<div class="toolbar" style="justify-content:flex-end;margin-top:4px">' + foot + '</div>' : '') + '</div>';
  }
  const memberByName = (name) => {
    name = String(name || '').trim(); if (!name) return null;
    const ms = J().activeMembers();
    return ms.find((m) => m.name === name) || ms.find((m) => name.includes(m.name) || m.name.includes(name)) || null;
  };

  /* =========================================================
   *  會議記錄
   * ========================================================= */
  function subscribe() {
    S().db.collection('meetings').onSnapshot((s) => {
      s.docChanges().forEach((c) => { if (c.type === 'removed') delete M.list[c.doc.id]; else M.list[c.doc.id] = { id: c.doc.id, ...c.doc.data() }; });
      if (S().view === 'meet') J().render();
    }, (e) => console.warn('meetings', e));
  }
  async function checkReady() {
    if (M.ready !== null) return;
    M.ready = 'loading';
    const r = await call('meeting', { mode: 'status' });
    M.ready = r && r.ok ? !!r.ready : 'error';
    if (S().view === 'meet') J().render();
  }

  // ---- 逐字稿分段（即時） ----
  async function loadSegs(id) {
    const { data } = await S().sb.from('meeting_segs').select('n,status,lines,error,updated_at').eq('meeting_id', id).order('n');
    M.segs[id] = {}; (data || []).forEach((r) => { M.segs[id][r.n] = r; });
    if (S().view === 'meet' && M.sel === id) J().render();
  }
  function watchSegs(id) {
    if (M.segSub && M.segSub.id === id) return;
    if (M.segSub) { try { S().sb.removeChannel(M.segSub.ch); } catch (_) {} }
    const ch = S().sb.channel('segs-' + id).on('postgres_changes', { event: '*', schema: 'public', table: 'meeting_segs', filter: 'meeting_id=eq.' + id }, (p) => {
      const r = p.new; if (!r || r.meeting_id === undefined) return;
      (M.segs[id] = M.segs[id] || {})[r.n] = r;
      if (S().view === 'meet' && M.sel === id) J().render();
    }).subscribe();
    M.segSub = { id, ch };
    loadSegs(id);
  }
  const winsOf = (d) => (Number(d) || 0) > WIN + 60 ? Math.ceil(Number(d) / WIN) : 1;
  function expected(m) {
    if (m.file) return [...Array(winsOf(m.dur))].map((_, i) => i);
    return (m.parts || []).flatMap((p) => [...Array(p.span || 1)].map((_, i) => p.n + i));
  }
  // 舊的「單一上傳檔」會議要加錄音／音檔時，先轉成一般格式
  function normParts(m) {
    const parts = (m.parts || []).map((p) => ({ ...p }));
    if (m.file && parts[0]) { parts[0].up = true; parts[0].span = winsOf(parts[0].dur || m.dur); parts[0].off = 0; }
    return parts;
  }
  const nextN = (parts) => parts.reduce((x, p) => Math.max(x, p.n + (p.span || 1)), 0);
  const sumDur = (parts) => Math.round(parts.reduce((x, p) => x + (Number(p.dur) || 0), 0));

  // ---- 處理：轉逐字稿、整理重點 ----
  async function transcribe(id, n) {
    const r = await call('meeting', { mode: 'seg', id, n });
    if (!r.ok) {
      if (r.error === 'missing_key') toast('還沒設定 Gemini 金鑰，請 Teresa 到 Supabase 設定 GEMINI_API_KEY');
      else if (r.error === 'quota') toast('Gemini 用量達到上限，稍後會再試');
      return false;
    }
    return true;
  }
  async function process(id, opts) {
    if (M.busy[id]) return; M.busy[id] = true;
    try {
      let m = M.list[id]; if (!m) return;
      await loadSegs(id);
      for (const n of expected(m)) {
        const s = (M.segs[id] || {})[n];
        if (s && (s.status === 'done' || s.status === 'empty') && !(opts && opts.redo)) continue;
        if (s && s.status === 'working' && !(opts && opts.force) && Date.now() - new Date(s.updated_at || 0) < 4 * 60e3) continue;
        const ok = await transcribe(id, n);
        if (!ok) { await loadSegs(id); return; }
      }
      await loadSegs(id);
      m = M.list[id];
      const all = expected(m).every((n) => ['done', 'empty'].includes(((M.segs[id] || {})[n] || {}).status));
      if (all && m.status !== 'recording' && (!m.summary || (opts && opts.resum))) {
        if (m.owner === (me() || {}).id) await S().db.doc('meetings/' + id).update({ status: 'summarizing' }).catch(() => {});
        const r = await call('meeting', { mode: 'summary', id });
        if (!r.ok) toast(r.error === 'no_transcript' ? '這段錄音沒有聽到說話內容' : '整理重點失敗，請按「重新整理重點」再試一次');
        else if (opts && opts.notify) notifyDone(id);
        await refetch(id);
      }
    } finally { delete M.busy[id]; if (S().view === 'meet') J().render(); }
  }
  async function refetch(id) {
    try { const d = await S().db.doc('meetings/' + id).get(); if (d.exists) M.list[id] = { id, ...d.data() }; } catch (_) {}
  }
  function notifyDone(id) {
    const m = M.list[id];
    toast('「' + ((m && m.title) || '會議') + '」的重點整理好了');
    try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('會議紀錄整理好了', { body: (m && m.title) || '' }); } catch (_) {}
  }

  // ---- 錄音 ----
  function pickMime() {
    const L = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    if (!window.MediaRecorder) return '';
    return L.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } }) || '';
  }
  const extOf = (mime) => /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /mpeg|mp3/.test(mime) ? 'mp3' : /wav/.test(mime) ? 'wav' : 'webm';

  const micId = () => { try { return localStorage.getItem('jj-mic') || ''; } catch (_) { return ''; } };
  // 實體會議／上課常常離說話的人比較遠：關掉降噪與回音消除（會把遠處人聲當雜音濾掉），保留自動增益
const micCons = () => ({ echoCancellation: false, noiseSuppression: false, autoGainControl: true, ...(micId() ? { deviceId: { ideal: micId() } } : {}) });
  // 開始前的麥克風測試：選輸入裝置、看音量條
  const T = { st: null, ctx: null, raf: 0 };
  function stopTest() { cancelAnimationFrame(T.raf); if (T.st) T.st.getTracks().forEach((t) => t.stop()); try { T.ctx && T.ctx.close(); } catch (_) {} T.st = T.ctx = null; }
  async function startTest() {
    stopTest();
    const box = document.getElementById('jx-mict'); if (!box) return;
    try {
      T.st = await navigator.mediaDevices.getUserMedia({ audio: micCons() });
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const cur = (T.st.getAudioTracks()[0].getSettings() || {}).deviceId || micId();
      const sel = document.getElementById('jx-micsel');
      if (sel) sel.innerHTML = devs.map((d, i) => '<option value="' + esc(d.deviceId) + '" ' + (d.deviceId === cur ? 'selected' : '') + '>' + esc(d.label || '麥克風 ' + (i + 1)) + '</option>').join('');
      const AC = window.AudioContext || window.webkitAudioContext; T.ctx = new AC(); try { await T.ctx.resume(); } catch (_) {}
      const an = T.ctx.createAnalyser(); an.fftSize = 512; T.ctx.createMediaStreamSource(T.st).connect(an);
      const a = new Uint8Array(an.fftSize); let peakAt = 0;
      const loop = () => {
        const bar = document.getElementById('jx-micbar'), tip = document.getElementById('jx-mictip');
        if (!bar) { stopTest(); return; }
        an.getByteTimeDomainData(a); let p = 0; for (const v of a) p = Math.max(p, Math.abs(v - 128));
        bar.style.width = Math.min(100, Math.round(Math.sqrt(p / 128) * 160)) + '%';
        if (p > 4) peakAt = Date.now();
        if (tip) tip.textContent = peakAt && Date.now() - peakAt < 1500 ? '✅ 有收到聲音' : '說說話試試看：綠色條要跟著跳動';
        T.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) { box.innerHTML = '<span class="hint">⚠️ 無法使用麥克風：請在網址列旁允許麥克風權限</span>'; }
  }

  async function startRec(o) {
    stopTest();
    if (M.rec) { toast('已經在錄音了'); return; }
    const m = me(); if (!m) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) { toast('這個瀏覽器不支援錄音，請改用 Chrome 或 Safari'); return; }
    const mime = pickMime();
    let mic = null, disp = null;
    try {
      if (o.source === 'tab') {
        disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { suppressLocalAudioPlayback: false }, systemAudio: 'include', selfBrowserSurface: 'exclude' });
        if (!disp.getAudioTracks().length) { disp.getTracks().forEach((t) => t.stop()); toast('沒有分享到聲音：請選「Chrome 分頁」並勾選「同時分享分頁音訊」'); return; }
      }
      mic = await navigator.mediaDevices.getUserMedia({ audio: micCons() });
    } catch (e) {
      if (disp) disp.getTracks().forEach((t) => t.stop());
      toast(e && e.name === 'NotAllowedError' ? '沒有取得麥克風權限：請在瀏覽器網址列旁允許使用麥克風' : '無法開始錄音：' + ((e && e.message) || ''));
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try { await ctx.resume(); } catch (_) {}
    const dest = ctx.createMediaStreamDestination();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    const addSrc = (st) => { const s = ctx.createMediaStreamSource(st); s.connect(dest); s.connect(an); };
    addSrc(mic); if (disp) addSrc(new MediaStream(disp.getAudioTracks()));
    const people = (o.people || []).filter(Boolean);
    const title = (o.title || '').trim();
    const into = o.into && M.list[o.into];
    const data = {
      owner: m.id, title: title || '會議 ' + J().fmtD(localDate()).split(' ')[0] + ' ' + hm(), autoTitle: !title,
      date: localDate(), startedAt: nowISO(), createdAt: nowISO(), status: 'recording', source: o.source || 'mic',
      parts: [], dur: 0, shared: [], people: [...new Set([m.name, ...people])], eventId: o.eventId || '', eventCal: o.eventCal || '', vocab: '', type: o.type || 'general',
      manual: !!o.manual,
    };
    let ref; let base = [];
    try {
      if (into) {
        base = normParts(into);
        const patch = { status: 'recording', parts: base, dur: sumDur(base), file: false, resumedAt: nowISO(), manual: !!o.manual };
        await S().db.doc('meetings/' + into.id).update(patch);
        ref = { id: into.id }; Object.assign(into, patch);
      } else { ref = await S().db.collection('meetings').add(data); M.list[ref.id] = { id: ref.id, ...data }; }
    } catch (e) {
      [mic, disp].forEach((s) => s && s.getTracks().forEach((t) => t.stop())); ctx.close();
      toast('無法建立會議記錄：' + ((e && e.message) || '')); return;
    }
    // 只有麥克風時直接錄麥克風音軌；AudioContext 只用來畫音量條。
    // （背景分頁時瀏覽器可能暫停 AudioContext，經過它錄音會錄到空檔。）
    const recStream = disp ? dest.stream : new MediaStream(mic.getAudioTracks());
    const R = M.rec = { id: ref.id, resume: !!into, manual: !!o.manual, mime, ctx, an, dest, mic, disp, stream: recStream, n: nextN(base), off: sumDur(base), segAt: Date.now(), segPaused: 0, pausedAt: 0, paused: false, parts: base.slice(), q: Promise.resolve(), pending: 0, failed: [], start: Date.now(), tick: null, mr: null };
    if (disp) disp.getVideoTracks().forEach((t) => { t.onended = () => { if (M.rec === R) toast('螢幕分享已停止，之後只錄得到麥克風'); }; });
    mic.getAudioTracks().forEach((t) => { t.onended = () => { if (M.rec === R) { toast('麥克風中斷了，已自動結束錄音'); stopRec(); } }; });
    newRecorder(R);
    R.tick = setInterval(() => tick(R), 500);
    wake(true);
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (_) {}
    closeModal();
    drawBar();
    toast(into ? '繼續錄音，會接在原本的錄音後面' : '開始錄音');
  }
  function segElapsed(R) { return (Date.now() - R.segAt - R.segPaused - (R.paused ? Date.now() - R.pausedAt : 0)) / 1000; }
  function newRecorder(R) {
    try { if (R.ctx && R.ctx.state !== 'running') R.ctx.resume(); } catch (_) {}
    let mr;
    try { mr = new MediaRecorder(R.stream, R.mime ? { mimeType: R.mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 }); }
    catch (_) { mr = new MediaRecorder(R.stream); }
    const chunks = []; const n = R.n; const off = R.off;
    mr._bytes = 0; mr._t0 = Date.now(); mr._ticks = 0; mr._act = 0;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) { chunks.push(e.data); mr._bytes += e.data.size; } };
    mr.onstop = () => {
      const dur = Math.max(1, Math.round(mr._dur || segElapsed(R)));
      const blob = new Blob(chunks, { type: (mr.mimeType || R.mime || 'audio/webm').split(';')[0] });
      if (dur > 20 && blob.size < 2000 && !mr._flag) emptySeg(R, n, dur);
      const act = mr._ticks >= 20 ? Math.round(mr._act / mr._ticks * 1000) / 1000 : null;
      if (blob.size > 0) enqueue(R, n, blob, off, dur, act);
      else if (R.finishing) maybeFinish(R);
    };
    mr.start(1000);
    R.mr = mr; R.segAt = Date.now(); R.segPaused = 0;
  }
  // 某一段幾乎沒有資料：提醒並嘗試重新接上麥克風
  async function emptySeg(R, n, dur) {
    R.empty = (R.empty || 0) + 1;
    console.warn('empty segment', n, dur);
    if (M.rec !== R) return;
    toast('⚠️ 第 ' + (n + 1) + ' 段沒有錄到聲音，正在重新接上麥克風…');
    try {
      try { await R.ctx.resume(); } catch (_) {}
      {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: micCons() });
        const old = R.mic; R.mic = mic;
        try { const src = R.ctx.createMediaStreamSource(mic); src.connect(R.an); if (R.disp) src.connect(R.dest); } catch (_) {}
        if (!R.disp) R.stream = new MediaStream(mic.getAudioTracks());
        cut(R);
        setTimeout(() => old.getTracks().forEach((t) => t.stop()), 1000);
        mic.getAudioTracks().forEach((t) => { t.onended = () => { if (M.rec === R) { toast('麥克風中斷了，已自動結束錄音'); stopRec(); } }; });
      }
      toast('已重新接上麥克風，錄音繼續中');
    } catch (e) { toast('⚠️ 麥克風沒有聲音，請檢查麥克風後重新開始錄音'); }
    drawBar();
  }
  function cut(R, final) {
    const old = R.mr; if (!old) return;
    const d = segElapsed(R); old._dur = d;
    R.off += d; R.n++;
    if (!final) newRecorder(R); else R.mr = null;
    try { old.stop(); } catch (_) {}
  }
  function tick(R) {
    if (M.rec !== R) return;
    if (!R.paused && segElapsed(R) >= SEG_SEC) cut(R);
    // 開始 20 秒後幾乎沒有資料 → 錄音沒有收到聲音，馬上補救
    const mr = R.mr;
    if (mr && !R.paused && !mr._flag && Date.now() - mr._t0 > 20000 && mr._bytes < 1500) { mr._flag = true; emptySeg(R, R.n, segElapsed(R)); }
    const el = document.getElementById('jxRecT'); if (el) el.textContent = mmss(totalElapsed(R));
    const lv = document.getElementById('jxRecL');
    if (R.an && !R.paused && !document.hidden && R.ctx && R.ctx.state === 'running') {
      const a = new Uint8Array(R.an.fftSize); R.an.getByteTimeDomainData(a); let p = 0; for (const v of a) p = Math.max(p, Math.abs(v - 128));
      if (lv) lv.style.width = Math.min(100, Math.round(Math.sqrt(p / 128) * 150)) + '%';
      if (R.mr) { R.mr._ticks++; if (p > 6) R.mr._act++; }
      // 連續 20 秒幾乎沒有聲音 → 提醒（麥克風被靜音、選錯輸入裝置、離說話的人太遠）
      if (p > 3) { R.quietAt = 0; if (R.quiet) { R.quiet = false; drawBar(); } }
      else { R.quietAt = R.quietAt || Date.now(); if (!R.quiet && Date.now() - R.quietAt > 20000) { R.quiet = true; drawBar(); toast('🔇 麥克風沒有收到聲音：請檢查麥克風是否靜音，或靠近說話的人'); } }
    }
  }
  function totalElapsed(R) { return R.off + (R.mr ? segElapsed(R) : 0); }
  function enqueue(R, n, blob, off, dur, act) {
    R.pending++;
    R.q = R.q.then(async () => {
      const path = R.id + '/' + String(n).padStart(3, '0') + '.' + extOf(blob.type);
      let ok = false;
      for (let i = 0; i < 6 && !ok; i++) {
        const { error } = await S().sb.storage.from('meetings').upload(path, blob, { contentType: blob.type, upsert: true });
        if (!error) ok = true; else { console.warn('upload', error); await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
      }
      if (!ok) { R.failed.push({ n, blob, off, dur, act }); toast('第 ' + (n + 1) + ' 段音檔上傳失敗，網路恢復後會再試'); return; }
      R.parts.push({ n, path, mime: blob.type, dur, off: Math.round(off), at: nowISO(), ...(act != null ? { act } : {}) });
      R.parts.sort((a, b) => a.n - b.n);
      const total = R.parts.reduce((s, p) => s + p.dur, 0);
      await S().db.doc('meetings/' + R.id).update({ parts: R.parts, dur: Math.round(total) }).catch((e) => console.warn(e));
      if (M.list[R.id]) { M.list[R.id].parts = R.parts.slice(); M.list[R.id].dur = Math.round(total); }
      if (!R.manual) await transcribe(R.id, n);
    }).catch((e) => console.warn(e)).finally(() => { R.pending--; maybeFinish(R); drawBar(); });
  }
  function retryFailed(R) {
    const f = R.failed.splice(0); f.forEach((x) => enqueue(R, x.n, x.blob, x.off, x.dur, x.act));
  }
  window.addEventListener('online', () => { if (M.rec && M.rec.failed.length) retryFailed(M.rec); if (M.done && M.done.failed.length) retryFailed(M.done); });
  function pauseRec() {
    const R = M.rec; if (!R || !R.mr) return;
    if (!R.paused) { try { R.mr.pause(); } catch (_) {} R.paused = true; R.pausedAt = Date.now(); }
    else { try { R.mr.resume(); } catch (_) {} R.segPaused += Date.now() - R.pausedAt; R.paused = false; }
    drawBar();
  }
  function stopRec() {
    const R = M.rec; if (!R) return;
    if (R.paused) { R.segPaused += Date.now() - R.pausedAt; R.paused = false; }
    clearInterval(R.tick);
    R.finishing = true;
    cut(R, true);
    [R.mic, R.disp].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
    try { R.ctx.close(); } catch (_) {}
    wake(false);
    M.rec = null; M.done = R;
    const st = R.manual ? 'recorded' : 'processing';
    S().db.doc('meetings/' + R.id).update({ status: st, endedAt: nowISO() }).catch(() => {});
    if (M.list[R.id]) M.list[R.id].status = st;
    drawBar();
    M.sel = R.id; M.tab = 'sum';
    location.hash = 'meet'; J().S.view = 'meet'; J().render();
    toast(R.manual ? '錄音已存好，需要時按「開始轉逐字稿」' : '錄音結束，正在整理逐字稿和重點…');
  }
  function maybeFinish(R) {
    if (!R.finishing || R.pending > 0 || R.mr || R.failed.length || R.summarized) return;
    R.summarized = true;
    if (M.done === R) M.done = null;
    drawBar();
    if (!R.manual) process(R.id, { notify: true, resum: !!R.resume }); else J().render();
  }
  let wl = null;
  async function wake(on) {
    try {
      if (on && 'wakeLock' in navigator) { wl = await navigator.wakeLock.request('screen'); }
      else if (!on && wl) { await wl.release(); wl = null; }
    } catch (_) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (!M.rec) return;
    try { if (M.rec.ctx && M.rec.ctx.state !== 'running') M.rec.ctx.resume(); } catch (_) {}
    if (document.visibilityState === 'visible') { wake(true); if (M.rec.hiddenAt && Date.now() - M.rec.hiddenAt > 5000 && /iPhone|iPad/.test(navigator.userAgent)) toast('剛剛離開畫面時，手機可能暫停了錄音'); M.rec.hiddenAt = 0; }
    else M.rec.hiddenAt = Date.now();
  });
  window.addEventListener('beforeunload', (e) => { if (M.rec || (M.done && M.done.pending)) { e.preventDefault(); e.returnValue = ''; } });

  function drawBar() {
    let b = document.getElementById('jxBar');
    const R = M.rec, D = M.done;
    const fab = document.getElementById('jxFab');
    if (fab) fab.hidden = !!(R || D) || !S().db || S().gate;
    document.body.classList.toggle('jx-on', !!(R || D));
    drawNotes();
    if (!R && !D) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('div'); b.id = 'jxBar'; b.className = 'jx-bar'; document.body.appendChild(b); }
    if (R) {
      const t = (M.list[R.id] || {}).title || '會議';
      b.innerHTML = '<span class="jx-dot' + (R.paused ? ' paused' : '') + '"></span><button class="jx-bt" data-jx="openMeet" data-id="' + esc(R.id) + '" title="' + esc(t) + '"><b id="jxRecT" class="mono">' + mmss(totalElapsed(R)) + '</b><span class="jx-lv"><i id="jxRecL"></i></span><span class="jx-tt">' + (R.quiet && !R.paused ? '🔇 沒有收到聲音' : esc(R.paused ? '已暫停' : t)) + '</span></button>' +
        '<button class="btn sm" data-jx="notes" aria-pressed="' + !!M.notesOpen + '">📝<span class="jx-bl"> 筆記</span></button><button class="btn sm" data-jx="pause">' + (R.paused ? '▶ 繼續' : '⏸ 暫停') + '</button><button class="btn sm jx-stop" data-jx="stop">■ 結束</button>';
    } else {
      b.innerHTML = '<span class="jx-spin"></span><span class="jx-tt">正在上傳最後的錄音…請先不要關閉頁面</span>' + (D.failed.length ? '<button class="btn sm" data-jx="retryUp">重試上傳</button>' : '');
    }
  }

  // ---- 錄音時的筆記 ----
  const noteTimers = {};
  function saveNotes(id, v) {
    const m = M.list[id]; if (m) m.notes = v;
    clearTimeout(noteTimers[id]);
    noteTimers[id] = setTimeout(() => { S().db.doc('meetings/' + id).update({ notes: v }).catch(() => toast('筆記沒有存到，請檢查網路')); }, 800);
  }
  function drawNotes() {
    let p = document.getElementById('jxNotes');
    const R = M.rec;
    if (!R || !M.notesOpen) { if (p) p.remove(); return; }
    if (p && p.dataset.id === R.id) return;
    if (p) p.remove();
    p = document.createElement('div'); p.id = 'jxNotes'; p.className = 'jx-notes'; p.dataset.id = R.id;
    p.innerHTML = '<div class="jx-nh"><b>📝 會議筆記</b><span class="hint">自動儲存，整理重點時會優先參考</span><button class="btn sm" data-jx="notesT" title="在游標位置插入目前的錄音時間">⏱ 插入時間</button><button class="jx-x" data-jx="notes" aria-label="收起筆記">✕</button></div>' +
      '<textarea id="jxNotesTa" placeholder="邊聽邊記：重點、待辦、想追問的事…"></textarea>';
    document.body.appendChild(p);
    const ta = p.querySelector('textarea'); ta.value = (M.list[R.id] || {}).notes || '';
    ta.addEventListener('input', () => saveNotes(R.id, ta.value));
  }
  document.addEventListener('input', (e) => { const el = e.target; if (el && el.dataset && el.dataset.jxf === 'notesD') saveNotes(el.dataset.id, el.value); });

  // ---- 上傳音檔 ----
  function fileDur(file) {
    return new Promise((res) => {
      const a = document.createElement('audio'); const u = URL.createObjectURL(file); let done = false;
      const fin = (v) => { if (done) return; done = true; URL.revokeObjectURL(u); res(v); };
      a.preload = 'metadata'; a.onloadedmetadata = () => fin(isFinite(a.duration) ? a.duration : 0); a.onerror = () => fin(0);
      setTimeout(() => fin(0), 10000); a.src = u;
    });
  }
  const mimeOf = (file) => file.type || ({ m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', aac: 'audio/aac' }[(file.name.split('.').pop() || '').toLowerCase()] || 'audio/mpeg');
  // 上傳一個或多個音檔：o.into 有值就加到那場會議後面，否則建立新的會議記錄
  async function uploadFiles(files, o) {
    const m = me(); if (!m || !files.length) return;
    o = o || {};
    const big = files.filter((f) => f.size > MAX_UP);
    if (big.length) { toast('「' + big[0].name + '」超過 50MB：請先切成兩段再上傳'); return; }
    files = files.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }));
    closeModal();
    let id = o.into && M.list[o.into] ? o.into : null;
    if (!id) {
      const title = o.title || files[0].name.replace(/\.[^.]+$/, '').slice(0, 40);
      const data = { owner: m.id, title, autoTitle: !o.title && /^(New Recording|新錄音|錄音|audio|record)/i.test(title), date: localDate(), startedAt: nowISO(), createdAt: nowISO(), status: 'uploading', source: 'file', file: false, parts: [], dur: 0, shared: [], people: [m.name, ...(o.people || [])], eventId: o.eventId || '', vocab: '', type: o.type || 'general' };
      try { const ref = await S().db.collection('meetings').add(data); id = ref.id; M.list[id] = { id, ...data }; } catch (e) { toast('無法建立會議記錄'); return; }
    }
    M.sel = id; M.tab = 'sum'; location.hash = 'meet'; S().view = 'meet'; J().render();
    const mt = M.list[id];
    let parts = normParts(mt);
    const st0 = mt.status;
    await S().db.doc('meetings/' + id).update({ status: 'uploading', parts, file: false }).catch(() => {});
    Object.assign(mt, { status: 'uploading', parts, file: false });
    let added = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i]; const mime = mimeOf(f);
      toast('上傳中…' + (files.length > 1 ? '（' + (i + 1) + ' / ' + files.length + '）' : ''));
      const dur = Math.round(await fileDur(f));
      const n = nextN(parts);
      const path = id + '/f' + String(n).padStart(3, '0') + '.' + extOf(mime + ' ' + f.name);
      const { error } = await S().sb.storage.from('meetings').upload(path, f, { contentType: mime, upsert: true });
      if (error) { toast('「' + f.name + '」上傳失敗：' + error.message); continue; }
      parts = [...parts, { n, path, mime, dur, off: sumDur(parts), span: winsOf(dur), up: true, name: f.name.slice(0, 80), at: nowISO() }];
      await S().db.doc('meetings/' + id).update({ parts, dur: sumDur(parts) }).catch(() => {});
      Object.assign(mt, { parts, dur: sumDur(parts) });
      added++;
    }
    const status = added ? (mt.manual ? 'recorded' : 'processing') : (st0 && st0 !== 'uploading' ? st0 : 'error');
    await S().db.doc('meetings/' + id).update({ status }).catch(() => {});
    mt.status = status; J().render();
    if (!added) return;
    if (mt.manual) { toast('音檔已加入，需要時按「開始轉逐字稿」'); return; }
    const d = parts.filter((p) => p.up).slice(-added).reduce((x, p) => x + (p.dur || 0), 0);
    toast('上傳完成，開始轉逐字稿' + (d > 900 ? '（約需 ' + Math.ceil(d / 600) + ' 分鐘）' : ''));
    process(id, { notify: true, resum: true });
  }

  // ---- 開始錄音的視窗 ----
  function openStart(o) {
    M.startOpts = o || {};
    const canTab = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !isMob();
    const src = M.startOpts.source || 'mic';
    const into = M.startOpts.into && M.list[M.startOpts.into];
    let b = into ? '<div class="jx-note">新的錄音會接在「' + esc(into.title || '會議') + '」原本的錄音後面（目前 ' + durTxt(into.dur || 0) + '），結束後會用全部內容重新整理重點。</div>' : '<label class="field"><span>會議名稱（可以留空，結束後會自動命名）</span><input type="text" id="jx-title" value="' + esc(M.startOpts.title || '') + '" maxlength="60" placeholder="例如：康軒教師研習討論"></label>';
    if (canTab) b += '<div class="field"><span>收音方式</span><div class="jx-src">' +
      '<label><input type="radio" name="jx-src" value="mic" ' + (src === 'mic' ? 'checked' : '') + '><b>🎙 實體會議</b><span class="hint">用電腦麥克風收音</span></label>' +
      '<label><input type="radio" name="jx-src" value="tab" ' + (src === 'tab' ? 'checked' : '') + '><b>💻 線上會議</b><span class="hint">Google Meet 等用 Chrome 開的會議：選擇會議分頁並勾選「分享分頁音訊」</span></label></div></div>';
    const ty = M.startOpts.type || guessType(M.startOpts);
    if (!into) b += '<div class="field"><span>會議類型（決定結束後怎麼整理）</span><div class="jx-types">' + TYPES.map(([k, l, d]) => '<label><input type="radio" name="jx-type" value="' + k + '" ' + (k === ty ? 'checked' : '') + '><b>' + l + '</b><span class="hint">' + d + '</span></label>').join('') + '</div></div>';
    if (!into && M.startOpts.people && M.startOpts.people.length) b += '<div class="hint">與會者：' + esc(M.startOpts.people.join('、')) + '</div>';
    let man = true; try { man = localStorage.getItem('jj-manual') !== '0'; } catch (_) {}
    b += '<div class="field" id="jx-mict"><span>麥克風測試</span><select id="jx-micsel" aria-label="選擇麥克風"><option>讀取中…</option></select><div class="jx-micm"><span class="jx-lv big"><i id="jx-micbar"></i></span><span class="hint" id="jx-mictip">說說話試試看：綠色條要跟著跳動</span></div></div>';
    b += '<label class="inline jx-man"><input type="checkbox" id="jx-manual" ' + (man ? 'checked' : '') + '> 錄完先存起來，我按「開始轉逐字稿」才整理</label>';
    b += '<div class="jx-note">📣 開始前請告知與會者會議正在錄音。' + (isMob() ? '<br>📱 錄音時請保持螢幕亮著、不要切換 App，否則手機可能會暫停錄音。' : '<br>Zoom、Teams 等電腦 App 的聲音瀏覽器抓不到：請開喇叭，用「實體會議」收音。') + '</div>';
    if (M.ready === false) b += '<div class="jx-note warn">⚠️ 還沒設定轉錄用的 Gemini 金鑰：可以先錄音，設定好之後再到「會議記錄」按「繼續整理」。</div>';
    modal(into ? '繼續錄音' : '開始錄音', b, '<label class="btn ghost" style="margin-right:auto">⬆ 上傳音檔<input type="file" id="jx-file" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac" multiple hidden></label><button class="btn" data-jx="close">取消</button><button class="btn primary jx-recbtn" data-jx="go">⏺ ' + (into ? '繼續錄音' : '開始錄音') + '</button>');
    setTimeout(() => { const t = document.getElementById('jx-title'); if (t && !isMob()) t.focus(); startTest(); }, 30);
  }

  // ---- 會議記錄頁 ----
  const STATUS = { recording: ['錄音中', 'rec'], uploading: ['上傳中', 'work'], processing: ['轉逐字稿中', 'work'], summarizing: ['整理重點中', 'work'], done: ['完成', 'ok'], error: ['錯誤', 'err'] , recorded: ['待轉譯', 'work']};
  function statusPill(m) {
    let st = m.status || 'processing';
    if (st === 'recording' && !(M.rec && M.rec.id === m.id) && stale(m)) st = 'stuck';
    const [l, c] = st === 'stuck' ? ['錄音中斷', 'err'] : (STATUS[st] || ['處理中', 'work']);
    return '<span class="jx-pill ' + c + '">' + l + '</span>';
  }
  function viewMeet() {
    checkReady();
    const my = me(); if (!my) return '<div class="page-head"><h1>會議記錄</h1></div>';
    const L = Object.values(M.list).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    if (M.sel && !M.list[M.sel]) M.sel = null;
    let h = '<div class="page-head"><div><div class="eyebrow">錄音 → 逐字稿 → 重點，只有你和你分享的人看得到</div><h1>會議記錄</h1></div><div class="toolbar">' +
      '<label class="btn">⬆ 上傳音檔<input type="file" id="jx-file2" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac" multiple hidden></label>' +
      '<button class="btn primary jx-recbtn" data-jx="start"' + (M.rec ? ' disabled' : '') + '>⏺ 開始錄音</button></div></div>';
    if (M.ready === false) h += '<div class="banner">⚠️ 轉逐字稿需要 Gemini 金鑰，還沒設定好。<span class="hint">管理員：到 Supabase → Edge Functions → Secrets 加入 <span class="mono">GEMINI_API_KEY</span>。設定前錄的音檔會保留，之後可以按「繼續整理」。</span></div>';
    const list = L.length ? L.map((m) => {
      const mine = m.owner === my.id; const ow = S().members[m.owner];
      return '<button class="jx-li' + (m.id === M.sel ? ' on' : '') + '" data-jx="sel" data-id="' + esc(m.id) + '"><div class="jx-lt">' + esc(m.title || '會議') + '</div><div class="jx-lm">' +
        '<span>' + esc(J().fmtD(m.date || '')) + '</span>' + (m.dur ? '<span>' + durTxt(m.dur) + '</span>' : '') + (m.type && m.type !== 'general' ? '<span>' + esc(typeLabel(m.type)) + '</span>' : '') + statusPill(m) +
        (!mine && ow ? '<span>' + esc(ow.name) + ' 分享</span>' : (m.shared || []).length ? '<span title="已分享">🔗 ' + m.shared.length + '</span>' : '') + '</div></button>';
    }).join('') : '<div class="empty">還沒有會議記錄。<br>按「⏺ 開始錄音」，或上傳手機錄好的音檔。</div>';
    const det = M.sel ? detail(M.list[M.sel]) : '<div class="panel"><div class="empty-illo">' + (J().illo ? J().illo(3) : '') + '<span>選一場會議看重點和逐字稿</span></div></div>';
    h += '<div class="jx-split' + (M.sel ? ' has-sel' : '') + '"><aside class="panel jx-list">' + list + '</aside><div class="jx-det">' + det + '</div></div>';
    return h;
  }
  function rangeTxt(a) {
    const out = []; let i = 0;
    while (i < a.length) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; out.push(j > i ? a[i] + '–' + a[j] : String(a[i])); i = j + 1; }
    return out.join('、');
  }
  function stale(m) {
    const last = Math.max(new Date(m.startedAt || 0).getTime(), new Date(m.resumedAt || 0).getTime(), ...(m.parts || []).map((p) => new Date(p.at || 0).getTime()));
    return Date.now() - last > (SEG_SEC + 180) * 1000;
  }
  function lineName(m, sp) { return (m.speakers || {})[sp] || sp; }
  function detail(m) {
    if (!m) return '';
    watchSegs(m.id);
    const my = me(); const own = m.owner === my.id; const D = own ? '' : 'disabled';
    const segs = M.segs[m.id] || {}; const exp = expected(m);
    const doneN = exp.filter((n) => ['done', 'empty'].includes((segs[n] || {}).status)).length;
    const empties = exp.filter((n) => (segs[n] || {}).status === 'empty');
    const errs = exp.filter((n) => (segs[n] || {}).status === 'error');
    const faint = exp.filter((n) => (segs[n] || {}).status === 'done' && (segs[n] || {}).error === 'faint');
    const live = M.rec && M.rec.id === m.id;
    const busy = !!M.busy[m.id] || (M.done && M.done.id === m.id);
    let h = '<div class="panel jx-dpanel"><div class="jx-dh">';
    h += '<button class="btn ghost sm only-mob" data-jx="unsel">‹ 列表</button>';
    h += '<input type="text" class="jx-title" id="jx-mtitle" data-jxf="title" data-id="' + esc(m.id) + '" value="' + esc(m.title || '') + '" ' + D + ' maxlength="60" aria-label="會議名稱">';
    h += '<div class="jx-meta"><span>' + esc(J().fmtD(m.date || '')) + ' ' + esc((m.startedAt ? new Date(m.startedAt) : new Date()).toTimeString().slice(0, 5)) + '</span>' + (m.dur ? '<span>' + durTxt(m.dur) + '</span>' : '') + '<span>' + ({ mic: '🎙 實體', tab: '💻 線上', file: '⬆ 上傳' }[m.source] || '') + '</span>' + (own ? '<select class="jx-tsel" data-jxf="type" data-id="' + esc(m.id) + '" aria-label="會議類型">' + TYPES.map(([k, l]) => '<option value="' + k + '" ' + (k === (m.type || 'general') ? 'selected' : '') + '>' + l + '</option>').join('') + '</select>' : '<span>' + esc(typeLabel(m.type)) + '</span>') + statusPill(m) + (!own ? '<span>' + esc((S().members[m.owner] || {}).name || '') + ' 錄的</span>' : '') + '</div>';
    // 分享
    const sh = m.shared || [];
    if (own) {
      const others = J().activeMembers().filter((x) => x.id !== my.id);
      h += '<div class="jx-share"><span class="hint">分享給：</span>' + sh.map((id) => { const x = S().members[id]; return x ? '<span class="chip">' + J().avatar(x) + esc(x.name) + '<button class="jx-x" data-jx="unshare" data-id="' + esc(m.id) + '" data-m="' + esc(id) + '" aria-label="取消分享給 ' + esc(x.name) + '">✕</button></span>' : ''; }).join('') +
        '<select data-jxf="share" data-id="' + esc(m.id) + '" aria-label="分享給夥伴" style="width:auto"><option value="">＋ 夥伴</option>' + others.filter((x) => !sh.includes(x.id)).map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>').join('') + '</select></div>';
    } else if (sh.length) h += '<div class="hint">分享給：' + sh.map((id) => esc((S().members[id] || {}).name || '')).join('、') + '</div>';
    if (own && !live && m.status !== 'recording' && m.status !== 'uploading' && !busy) h += '<div class="jx-more"><button class="btn sm" data-jx="recMore" data-id="' + esc(m.id) + '">⏺ 繼續錄音</button><label class="btn sm">⬆ 加入音檔<input type="file" id="jx-fileAdd" data-id="' + esc(m.id) + '" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac" multiple hidden></label><span class="hint">錄音中斷了？可以接著錄，或把其他音檔加進來</span></div>';
    h += '</div>';
    // 進度
    if (live) h += '<div class="jx-prog"><span class="jx-dot"></span> 錄音中，每 5 分鐘會先轉一段逐字稿（已完成 ' + doneN + ' 段）</div>';
    else if (m.status === 'recording' && !live && !stale(m)) h += '<div class="jx-prog"><span class="jx-dot"></span> ' + esc((S().members[m.owner] || {}).name || '') + ' 正在另一個裝置錄音（已上傳 ' + (m.parts || []).length + ' 段）' + (own ? '<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap"><span class="hint">其實已經停了？</span><button class="btn sm primary" data-jx="recMore" data-id="' + esc(m.id) + '">⏺ 接著錄</button><label class="btn sm">⬆ 加入音檔<input type="file" id="jx-fileAdd" data-id="' + esc(m.id) + '" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac" multiple hidden></label></span>' : '') + '</div>';
    else if (m.status === 'recording' && !live) h += '<div class="jx-prog warn">這場錄音沒有正常結束（可能關掉了頁面）。已上傳 ' + (m.parts || []).length + ' 段。' + (own ? ' <button class="btn sm primary" data-jx="recMore" data-id="' + esc(m.id) + '">⏺ 接著錄</button> <label class="btn sm">⬆ 加入音檔<input type="file" id="jx-fileAdd" data-id="' + esc(m.id) + '" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.aac" multiple hidden></label> <button class="btn sm" data-jx="finish" data-id="' + esc(m.id) + '">用已上傳的部分整理</button>' : '') + '</div>';
    else if (m.status === 'recorded' && !busy) h += '<div class="jx-prog"><div style="flex:1">🎙 錄音已存好（' + durTxt(m.dur || 0) + '）。' + (own ? '確認錄完了，再按右邊的按鈕。' : '等 ' + esc((S().members[m.owner] || {}).name || '') + ' 開始轉譯。') + '</div>' + (own ? '<button class="btn sm primary" data-jx="transcribe" data-id="' + esc(m.id) + '">開始轉逐字稿與整理重點</button>' : '') + '</div>';
    else if (m.status !== 'done' || busy) {
      const pct = exp.length ? Math.round(doneN / exp.length * 100) : 0;
      h += '<div class="jx-prog"><div style="flex:1"><div>' + (m.status === 'uploading' ? '上傳音檔中…' : m.status === 'summarizing' || (doneN === exp.length && exp.length) ? '整理重點中…' : '轉逐字稿中… ' + doneN + ' / ' + exp.length + ' 段') + '</div><div class="bar"><span style="width:' + pct + '%"></span></div></div>' +
        (!busy && m.status !== 'uploading' ? '<button class="btn sm" data-jx="resume" data-id="' + esc(m.id) + '">繼續整理</button>' : '<span class="jx-spin"></span>') + '</div>';
    }
    if (empties.length) h += '<div class="jx-prog warn">第 ' + rangeTxt(empties.map((n) => n + 1)) + ' 段（每段 5 分鐘）沒有錄到聲音，這部分沒有逐字稿。</div>';
    if (faint.length) h += '<div class="jx-prog warn">第 ' + rangeTxt(faint.map((n) => n + 1)) + ' 段聲音很小或很遠，逐字稿可能不完整。錄音時請把手機或電腦放近說話的人。</div>';
    if (errs.length && !busy) h += '<div class="jx-prog warn">第 ' + errs.map((n) => n + 1).join('、') + ' 段轉錄失敗：' + esc(String((segs[errs[0]] || {}).error || '').slice(0, 120)) + ' <button class="btn sm" data-jx="resume" data-id="' + esc(m.id) + '" data-force="1">重試</button></div>';
    // 分頁
    const sm = m.summary || null; const todos = (sm && sm.todos) || [];
    h += '<div class="tabs2" style="margin:0;padding:0 14px">' + [['sum', '重點'], ['todo', todoLabel(m) + (todos.length ? ' ' + todos.length : '')], ['tx', '逐字稿']].map(([k, l]) => '<button data-jx="tab" data-v="' + k + '" aria-pressed="' + (M.tab === k) + '">' + l + '</button>').join('') + '</div><div class="jx-body">';
    if (M.tab === 'tx') h += txView(m, segs, exp, own);
    else if (M.tab === 'todo') h += todoView(m, todos, own);
    else h += notesView(m, own, live) + sumView(m, sm, own);
    h += '</div>';
    if (own) h += '<div class="jx-foot">' + (M.confirmDel === m.id ? '<span class="sub">刪除這場會議的錄音、逐字稿和重點？</span> <button class="btn sm danger" data-jx="del" data-id="' + esc(m.id) + '">刪除</button> <button class="btn sm ghost" data-jx="delNo">取消</button>' : '<button class="btn sm ghost" data-jx="askDel" data-id="' + esc(m.id) + '">刪除會議記錄</button>') + '</div>';
    return h + '</div>';
  }
  function notesView(m, own, live) {
    const v = m.notes || '';
    if (live) return '<div class="jx-ndet"><h3>📝 我的筆記</h3><p class="hint">錄音中，請在下方錄音列按「📝 筆記」記錄。</p>' + (v ? '<div class="jx-npre">' + esc(v) + '</div>' : '') + '</div>';
    if (own) return '<details class="jx-ndet"' + (v ? ' open' : '') + '><summary><b>📝 我的筆記</b>' + (v ? '' : '<span class="hint">（可以補充重點，整理時會一起參考）</span>') + '</summary><textarea class="jx-nta" data-jxf="notesD" data-id="' + esc(m.id) + '" placeholder="補充重點、待辦、想追問的事…">' + esc(v) + '</textarea>' + (m.summary ? '<p class="hint" style="margin:4px 0 0">改了筆記之後，按下方「↻ 重新整理重點」就會納入。</p>' : '') + '</details>';
    return v ? '<div class="jx-ndet"><h3>📝 ' + esc((S().members[m.owner] || {}).name || '') + ' 的筆記</h3><div class="jx-npre">' + esc(v) + '</div></div>' : '';
  }
  function sumView(m, sm, own) {
    if (!sm) return '<div class="empty">' + (m.status === 'recording' ? '錄音結束後會自動整理重點。' : '重點整理好之後會出現在這裡。') + '</div>';
    const ul = (a) => '<ul class="jx-ul">' + a.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    let h = '';
    if (sm.type && sm.type !== (m.type || 'general')) h += '<div class="jx-note warn" style="margin-top:10px">這份重點是用「' + esc(typeLabel(sm.type)) + '」的格式整理的。' + (own ? '<button class="btn sm" data-jx="resum" data-id="' + esc(m.id) + '">改用「' + esc(typeLabel(m.type)) + '」重新整理</button>' : '') + '</div>';
    secs(sm).forEach((sec, i) => { if (sec.items.length || i === 0) h += '<h3>' + esc(sec.h) + '</h3>' + (sec.items.length ? ul(sec.items) : '<p class="hint">沒有。</p>'); });
    if (sm.todos.length) h += '<h3>' + todoLabel(m) + '</h3><ul class="jx-ul">' + sm.todos.map((t) => '<li>' + esc(t.text) + (t.owner ? '<span class="hint">・' + esc(t.owner) + '</span>' : '') + (t.due ? '<span class="hint">・' + esc(J().fmtD(t.due)) + '</span>' : '') + '</li>').join('') + '</ul>';
    // Slack
    const chans = slackOptions(m);
    h += '<div class="jx-actions"><button class="btn sm" data-jx="copy" data-id="' + esc(m.id) + '">📋 複製會議紀錄</button>' +
      '<span class="jx-slack"><select id="jx-slack" aria-label="傳到哪個 Slack 頻道">' + chans.map(([v, l]) => '<option value="' + esc(v) + '" ' + (v === M.slackCh ? 'selected' : '') + '>' + esc(l) + '</option>').join('') + '</select><button class="btn sm" data-jx="slack" data-id="' + esc(m.id) + '">傳到 Slack</button></span>' +
      (own ? '<button class="btn sm ghost" data-jx="resum" data-id="' + esc(m.id) + '" title="改了說話者名字之後，可以用新名字重新整理">↻ 重新整理重點</button>' : '') + '</div>';
    return h;
  }
  function slackOptions(m) {
    const my = me(); const o = [];
    if (my && my.slackId) o.push([my.slackId, '私訊給我']);
    Object.values(S().depts).filter((d) => d.slackChannel).sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((d) => o.push([d.slackChannel, '#' + (d.slackChannelName || d.name)]));
    Object.values(S().projects).filter((p) => p.slackChannel && p.status !== 'archived').forEach((p) => o.push([p.slackChannel, '專案：' + p.name]));
    o.push(['C01N8DC3544', '#general']);
    const seen = new Set(); return o.filter(([v]) => (seen.has(v) ? false : seen.add(v)));
  }
  function todoView(m, todos, own) {
    if (!m.summary) return '<div class="empty">重點整理好之後，會議中提到的下一步行動會列在這裡。</div>';
    if (!todos.length) return '<div class="empty">' + (m.type === 'lecture' ? '這堂課沒有整理出可應用的行動或作業。' : '這場會議沒有需要追蹤的下一步行動。') + '</div>';
    const my = me(); const st = m.todoState || {};
    const projs = Object.values(S().projects).filter((p) => p.status !== 'archived' && J().visibleProjectIds().has(p.id));
    let h = '<div class="jx-tdhead"><span class="hint">加到專案任務時放進：</span><select id="jx-tdproj" aria-label="加到哪個專案"><option value="">選擇專案…</option>' + projs.map((p) => '<option value="' + esc(p.id) + '" ' + (p.id === M.tdProj ? 'selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></div>';
    h += todos.map((t, i) => {
      const s = st[i] || {}; const mm = s.owner ? S().members[s.owner] : memberByName(t.owner); const ownerId = s.owner || (mm ? mm.id : '');
      const due = s.due !== undefined ? s.due : t.due;
      return '<div class="jx-td' + (s.added ? ' added' : '') + '"><div class="jx-tdt">' + esc(t.text) + '</div><div class="jx-tdc">' +
        '<select data-jxf="tdOwner" data-id="' + esc(m.id) + '" data-i="' + i + '" aria-label="負責人" ' + (own ? '' : 'disabled') + '><option value="">' + (t.owner && !mm ? esc(t.owner) + '（不在名單）' : '負責人') + '</option>' + J().activeMembers().map((x) => '<option value="' + esc(x.id) + '" ' + (x.id === ownerId ? 'selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select>' +
        '<input type="date" data-jxf="tdDue" data-id="' + esc(m.id) + '" data-i="' + i + '" value="' + esc(due || '') + '" aria-label="期限" ' + (own ? '' : 'disabled') + '>' +
        (s.added ? '<span class="jx-ok">✓ 已加入' + (s.added === 'task' ? '專案任務' : '待辦') + '</span>' :
          ((ownerId === my.id || !ownerId) ? '<button class="btn sm" data-jx="toTodo" data-id="' + esc(m.id) + '" data-i="' + i + '">＋ 我的待辦</button>' : '') +
          (!J().isOutsourced() ? '<button class="btn sm" data-jx="toTask" data-id="' + esc(m.id) + '" data-i="' + i + '">＋ 專案任務</button>' : '')) +
        '</div></div>';
    }).join('');
    return h;
  }
  function txView(m, segs, exp, own) {
    const lines = exp.flatMap((n) => ((segs[n] || {}).status === 'done' ? segs[n].lines : []));
    if (!lines.length) return '<div class="empty">' + (exp.length ? '逐字稿轉好之後會出現在這裡。' : '還沒有錄音。') + '</div>';
    const labels = [...new Set(lines.map((l) => l.sp))];
    let h = '';
    if (own && labels.length) {
      h += '<details class="jx-spk"' + (labels.some((l) => /^說話者/.test(l) && !(m.speakers || {})[l]) ? ' open' : '') + '><summary>👥 說話者名稱</summary><div class="jx-spkg">' +
        labels.map((l) => '<label><span>' + esc(l) + '</span><input type="text" list="jx-names" data-jxf="spk" data-id="' + esc(m.id) + '" data-l="' + esc(l) + '" value="' + esc((m.speakers || {})[l] || '') + '" placeholder="改成…"></label>').join('') +
        '</div><datalist id="jx-names">' + J().activeMembers().map((x) => '<option value="' + esc(x.name) + '">').join('') + '</datalist><p class="hint" style="margin:6px 0 0">改完名字後，到「重點」按「重新整理重點」就會用新名字。</p></details>';
    }
    const pending = exp.length - exp.filter((n) => ['done', 'empty'].includes((segs[n] || {}).status)).length;
    h += '<div class="jx-tools"><button class="btn sm" data-jx="dlTx" data-id="' + esc(m.id) + '">⬇ 下載逐字稿</button><button class="btn sm" data-jx="copyTx" data-id="' + esc(m.id) + '">📋 複製</button>' + (own && !m.purged && m.status !== 'recording' && !M.busy[m.id] ? '<button class="btn sm ghost" data-jx="retx" data-id="' + esc(m.id) + '" title="逐字稿怪怪的時候，可以用原始錄音重新轉一次">↻ 重新轉錄</button>' : '') + (m.purged ? '<span class="hint">錄音檔已超過 30 天自動刪除，逐字稿保留</span>' : '<span class="hint">點時間可以播放那一段錄音</span>') + '</div>';
    h += '<audio id="jxAudio" controls preload="none" style="width:100%;' + (M.playing === m.id ? '' : 'display:none') + '"></audio>';
    const col = {}; labels.forEach((l, i) => { col[l] = ['var(--blue)', 'var(--amber)', 'var(--green)', 'var(--violet)', 'var(--red)', '#0f8b8d', '#6b7a1a', '#3d5a99'][i % 8]; });
    let last = '';
    h += '<div class="jx-tx">' + lines.map((l) => {
      const same = l.sp === last; last = l.sp;
      return '<div class="jx-ln' + (same ? ' same' : '') + '"><button class="jx-t mono" data-jx="play" data-id="' + esc(m.id) + '" data-t="' + l.t + '"' + (m.purged ? ' disabled' : '') + '>' + mmss(l.t) + '</button><div><b style="color:' + col[l.sp] + '">' + (same ? '' : esc(lineName(m, l.sp))) + '</b><div>' + esc(l.text) + '</div></div></div>';
    }).join('') + '</div>';
    if (pending) h += '<p class="hint">還有 ' + pending + ' 段在轉…</p>';
    return h;
  }
  function txText(m) {
    const segs = M.segs[m.id] || {};
    return expected(m).flatMap((n) => ((segs[n] || {}).status === 'done' ? segs[n].lines : [])).map((l) => '[' + mmss(l.t) + '] ' + lineName(m, l.sp) + '：' + l.text).join('\n');
  }
  function summaryText(m) {
    const sm = m.summary || { sections: [], todos: [] };
    const L = ['📝 ' + (m.title || '會議') + '（' + J().fmtD(m.date || '') + '・' + typeLabel(m.type) + '）', ''];
    secs(sm).forEach((sec) => { if (sec.items.length) { L.push('*' + sec.h + '*'); sec.items.forEach((x) => L.push('• ' + x)); L.push(''); } });
    if (sm.todos.length) { L.push('*' + todoLabel(m) + '*'); sm.todos.forEach((t, i) => { const s = (m.todoState || {})[i] || {}; const o = s.owner ? (S().members[s.owner] || {}).name : t.owner; const d = s.due !== undefined ? s.due : t.due; L.push('☐ ' + t.text + (o ? '（' + o + '）' : '') + (d ? '・' + J().fmtD(d) : '')); }); L.push(''); }
    return L.join('\n').trim();
  }
  async function copy(t) {
    try { await navigator.clipboard.writeText(t); toast('已複製'); }
    catch (_) { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); toast('已複製'); } catch (e) { toast('無法複製'); } a.remove(); }
  }
  async function play(m, t) {
    const parts = m.parts || []; if (!parts.length) return;
    const p = m.file ? parts[0] : (parts.filter((x) => (x.off || 0) <= t + 0.5).pop() || parts[0]);
    const key = p.path; let url = M.audioUrl[key];
    if (!url || url.exp < Date.now()) {
      const { data, error } = await S().sb.storage.from('meetings').createSignedUrl(p.path, 3600);
      if (error || !data) { toast('讀不到錄音檔'); return; }
      url = M.audioUrl[key] = { u: data.signedUrl, exp: Date.now() + 3500e3 };
    }
    M.playing = m.id;
    const a = document.getElementById('jxAudio'); if (!a) return;
    a.style.display = '';
    const at = m.file ? t : t - (p.off || 0);
    const go = () => { try { a.currentTime = Math.max(0, at - 1); } catch (_) {} a.play().catch(() => {}); };
    if (a.dataset.src !== key) { a.dataset.src = key; a.src = url.u; a.addEventListener('loadedmetadata', go, { once: true }); a.load(); } else go();
  }
  async function delMeeting(id) {
    const { data } = await S().sb.storage.from('meetings').list(id, { limit: 1000 });
    const paths = (data || []).map((f) => id + '/' + f.name);
    if (paths.length) await S().sb.storage.from('meetings').remove(paths);
    if (await J().W(S().db.doc('meetings/' + id).delete(), '已刪除')) { delete M.list[id]; M.sel = null; M.confirmDel = null; J().render(); }
  }
  async function setTodoState(m, i, patch) {
    const st = { ...(m.todoState || {}) }; st[i] = { ...(st[i] || {}), ...patch };
    m.todoState = st;
    if (m.owner === me().id) await S().db.doc('meetings/' + m.id).update({ todoState: st }).catch((e) => console.warn(e));
    J().render();
  }

  /* =========================================================
   *  Google 日曆（個人授權）
   * ========================================================= */
  async function gStatus(force) {
    if (G.st && !force && (G.st.loading || Date.now() - G.st.at < 600000)) return;
    G.st = { ...(G.st || {}), loading: true, at: Date.now() };
    const r = await call('gcal', { mode: 'status' });
    G.st = r.ok ? { ...r, at: Date.now() } : { at: Date.now(), error: r.error || 'error' };
    if (G.st.ready && !G.st.connected) loadGis();
    J().render();
  }
  function selCals() { try { const v = JSON.parse(localStorage.getItem('jj-gcals') || 'null'); return Array.isArray(v) && v.length ? v : null; } catch (_) { return null; } }
  async function loadWeek(from, to, force) {
    if (!G.st || !G.st.connected) return;
    const key = from + to + JSON.stringify(selCals());
    const c = G.ev;
    if (!force && c && c.key === key && (c.loading || Date.now() - c.at < 120000)) return;
    G.ev = { key, loading: true, at: Date.now(), list: (c && c.key === key && c.list) || [] };
    const r = await call('gcal', { mode: 'list', from, to, cals: selCals() || undefined });
    if (r.ok) { G.ev = { key, at: Date.now(), list: r.events }; G.cals = r.calendars; }
    else {
      G.ev = { key, at: Date.now(), list: [], error: r.error };
      if (r.error === 'reauth' || r.error === 'not_connected') { G.st = { ...G.st, connected: false }; loadGis(); toast('Google 日曆授權過期了，請重新連結'); }
    }
    J().render();
  }
  function invalidate() { if (G.ev) G.ev.at = 0; J().render(); }
  function loadGis() {
    if (G.gis) return G.gis;
    G.gis = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    G.gis.catch(() => { G.gis = null; });
    return G.gis;
  }
  async function connect() {
    if (!G.st || !G.st.ready) { toast('管理員還沒設定 Google 授權（GOOGLE_OAUTH_CLIENT_ID）'); return; }
    if (!window.google || !google.accounts || !google.accounts.oauth2) { try { await loadGis(); } catch (_) { toast('無法載入 Google 登入，請檢查網路或關閉擋廣告外掛'); return; } }
    const m = me();
    const client = google.accounts.oauth2.initCodeClient({
      client_id: G.st.clientId, scope: SCOPE, ux_mode: 'popup', prompt: 'consent', login_hint: (m && m.email) || '',
      callback: async (resp) => {
        if (resp.error) { toast('沒有完成授權'); return; }
        toast('連結中…');
        const r = await call('gcal', { mode: 'connect', code: resp.code });
        if (!r.ok) { toast(r.error === 'scope_missing' ? '要勾選「查看、編輯日曆活動」的權限才能使用' : '連結失敗：' + (r.error || '')); return; }
        G.st = { ...G.st, connected: true, email: r.email, at: Date.now() };
        if (m && m.email && r.email && r.email.toLowerCase() !== m.email.toLowerCase()) toast('已連結 ' + r.email + '（和登入的帳號不同）'); else toast('已連結 Google 日曆');
        G.ev = null; if (G.modal === 'gset') gSettings(); J().render();
      },
      error_callback: (e) => { if (e && e.type !== 'popup_closed') toast('無法開啟授權視窗：請允許這個網站開啟彈出式視窗'); },
    });
    client.requestCode();
  }
  async function disconnect() {
    if (!confirm('取消連結 Google 日曆？之後工作台就不能新增或修改你的活動。')) return;
    await call('gcal', { mode: 'disconnect' });
    G.st = { ...G.st, connected: false, email: '' }; G.ev = null; G.cals = null; loadGis();
    if (G.modal === 'gset') gSettings(); J().render(); toast('已取消連結');
  }
  async function gSettings() {
    G.modal = 'gset';
    const st = G.st || {};
    let b = '';
    if (!st.ready) b += '<p class="sub">管理員還沒設定 Google 授權。設定好之後，每個人都可以在工作台新增、修改自己的 Google 日曆活動。</p>';
    else if (!st.connected) b += '<p class="sub" style="margin:0">用你自己的 Google 帳號授權後，可以在「我的任務」週曆直接<b>新增、修改、刪除活動</b>、<b>邀請與會者</b>、<b>加 Meet 連結</b>和<b>回覆邀請</b>。</p><p class="hint" style="margin:0">授權畫面如果出現「Google 尚未驗證這個應用程式」，按「進階」→「前往職掘工作台」即可。只有你自己的日曆，別人看不到你的授權。</p>';
    else {
      if (!G.cals) { const r = await call('gcal', { mode: 'cals' }); if (r.ok) G.cals = r.calendars; }
      const sel = selCals() || (G.cals || []).filter((c) => c.primary).map((c) => c.id);
      b += '<p class="sub" style="margin:0">已連結 <b>' + esc(st.email || '') + '</b></p><div class="field"><span>週曆要顯示哪些日曆</span><div class="jx-cals">' + (G.cals || []).map((c) => '<label class="inline"><input type="checkbox" data-jxf="gcal" value="' + esc(c.id) + '" ' + (sel.includes(c.id) ? 'checked' : '') + '><i style="background:' + esc(c.color) + '"></i>' + esc(c.name) + (c.primary ? '（主要）' : '') + (c.role === 'reader' || c.role === 'freeBusyReader' ? ' <span class="hint">唯讀</span>' : '') + '</label>').join('') + '</div><span class="hint">公司行事曆已經另外顯示（🏢），不用重複勾選。</span></div>';
    }
    modal('我的 Google 日曆', b, st.connected ? '<button class="btn ghost danger" data-jx="gdisc" style="margin-right:auto">取消連結</button><button class="btn primary" data-jx="close">完成</button>' : '<button class="btn" data-jx="close">稍後</button>' + (st.ready ? '<button class="btn primary" data-jx="gconn">連結 Google 日曆</button>' : ''));
  }
  function evOn(day) {
    const L = (G.ev && G.ev.list) || [];
    return L.filter((e) => { const r = J().evRange(e); if (r.allDay) return r.sd <= day && day < r.ed; return r.s.slice(0, 10) <= day && day <= r.e.slice(0, 10) && !(r.e.slice(0, 10) === day && r.e.slice(11, 16) === '00:00' && r.s.slice(0, 10) < day); });
  }
  function dayEvents(day) { return dayEventItems(day).map((x) => x.h).join(''); }
  function dayEventItems(day) {
    return evOn(day).map((e) => {
      const l = J().evLabel(e, day);
      const declined = e.rs === 'declined', tent = e.rs === 'needsAction' || e.rs === 'tentative';
      return '<div class="td calev jx-ev' + (declined ? ' declined' : '') + '" data-jx="gopen" data-cal="' + esc(e.cal) + '" data-id="' + esc(e.id) + '" title="點一下編輯" style="border-left-color:' + esc(e.color || 'var(--c-meet)') + '"><div style="min-width:0;flex:1"><div class="tt">' + (tent ? '❔ ' : '📅 ') + esc(l.title) + (e.meet ? ' <span title="有 Meet 連結">🎥</span>' : '') + '</div><div class="sub2">' + esc(l.tm) + (l.loc ? '・' + esc(l.loc) : '') + (e.attendees && e.attendees.length > 1 ? '・' + e.attendees.length + ' 人' : '') + '</div></div></div>';
    }).map((h, i) => ({ e: evOn(day)[i], h }));
  }
  function weekToolbar() {
    const st = G.st;
    if (!st || st.loading && !('connected' in st)) return '';
    if (st.connected) return '<button class="btn sm" data-jx="gset" title="已連結 ' + esc(st.email || '') + '">📅 Google 日曆</button>';
    if (!st.ready) return '';
    return '<button class="btn sm primary" data-jx="gset">📅 連結 Google 日曆</button>';
  }
  function findEv(cal, id) { return ((G.ev && G.ev.list) || []).find((e) => e.cal === cal && e.id === id) || (S().compR && (S().compR.events || []).find((e) => e.cal === cal && e.id === id)); }

  // ---- 活動編輯視窗 ----
  async function openEvent(cal, id, day) {
    const my = me();
    let e = null;
    if (id) {
      e = findEv(cal, id);
      if (!G.st || !G.st.connected) { G.edit = { cal, id, e, ro: true }; drawEdit(); return; }
      G.edit = { cal, id, e, loading: true }; drawEdit();
      const r = await call('gcal', { mode: 'get', cal, id });
      if (r.ok) e = r.event; else if (r.error === 'not_found' || r.error === 'forbidden') { G.edit = { cal, id, e, ro: true, why: '你的 Google 帳號沒有這個日曆的權限' }; drawEdit(); return; }
      G.edit = { cal, id, e }; drawEdit(); return;
    }
    if (!G.st || !G.st.connected) { gSettings(); return; }
    const d = day || J().today();
    const h = new Date().getHours() + 1; const st = pad(Math.min(22, Math.max(9, h))) + ':00';
    G.edit = { cal: (selCals() || [])[0] || 'primary', id: '', isNew: true, e: { summary: '', start: { dateTime: d + 'T' + st }, end: { dateTime: d + 'T' + pad(Number(st.slice(0, 2)) + 1) + ':00' }, attendees: my && my.email ? [{ email: my.email, self: true }] : [], canEdit: true, mine: true } };
    drawEdit();
  }
  function drawEdit() {
    const x = G.edit; if (!x) return; G.modal = 'gedit';
    const e = x.e || {}; const my = me();
    if (x.loading && !e.summary) { modal('活動', '<div class="empty">讀取中…</div>'); return; }
    const r = J().evRange(e); const allDay = r.allDay;
    const d0 = allDay ? r.sd : r.s.slice(0, 10), d1 = allDay ? J().addDays(r.ed, -1) : r.e.slice(0, 10);
    const t0 = allDay ? '09:00' : r.s.slice(11, 16), t1 = allDay ? '10:00' : r.e.slice(11, 16);
    const can = !x.ro && (x.isNew || e.canEdit);
    const D = can ? '' : 'disabled';
    const att = (e.attendees || []).filter((a) => !a.self || !a.org);
    const memberMails = new Map(J().activeMembers().filter((m) => m.email && m.id !== (my || {}).id).map((m) => [m.email.toLowerCase(), m]));
    const picked = new Set(att.map((a) => String(a.email).toLowerCase()));
    const others = att.filter((a) => !memberMails.has(String(a.email).toLowerCase()) && !a.self).map((a) => a.email);
    const rsI = { accepted: '✅', declined: '❌', tentative: '❔', needsAction: '⏳' };
    const company = x.cal === (J().COMPANY_CAL || '') || (S().compCals || []).some((c) => c.id === x.cal);
    let b = '';
    if (x.ro) b += '<div class="jx-note">' + esc(x.why || '連結你的 Google 日曆後，就能在這裡修改活動。') + (!x.why && G.st && G.st.ready ? ' <button class="btn sm primary" data-jx="gconn">連結 Google 日曆</button>' : '') + '</div>';
    else if (!can) b += '<div class="jx-note">這個活動由 ' + esc(e.organizer || '別人') + ' 建立，你只能回覆邀請。</div>';
    b += '<label class="field"><span>標題</span><input type="text" id="ge-sum" value="' + esc(e.summary || '') + '" maxlength="300" ' + D + ' placeholder="例如：MIT 美語寒假營討論"></label>';
    b += '<div class="jx-when"><label class="inline"><input type="checkbox" id="ge-all" ' + (allDay ? 'checked' : '') + ' ' + D + ' data-jxf="geAll"> 整天</label>' +
      '<label class="field' + (allDay ? '' : ' jx-full') + '"><span>' + (allDay ? '開始日' : '日期') + '</span><input type="date" id="ge-d0" value="' + esc(d0) + '" ' + D + '></label>' +
      (allDay ? '<label class="field"><span>結束日</span><input type="date" id="ge-d1" value="' + esc(d1) + '" ' + D + '></label>'
        : '<label class="field"><span>開始</span><input type="time" id="ge-t0" value="' + esc(t0) + '" step="300" ' + D + ' data-jxf="geT0"></label><label class="field"><span>結束</span><input type="time" id="ge-t1" value="' + esc(t1) + '" step="300" ' + D + '></label>') + '</div>';
    if (x.isNew && G.cals) {
      const w = G.cals.filter((c) => c.role === 'owner' || c.role === 'writer');
      if (w.length > 1) b += '<label class="field"><span>日曆</span><select id="ge-cal">' + w.map((c) => '<option value="' + esc(c.id) + '" ' + (c.id === x.cal || (x.cal === 'primary' && c.primary) ? 'selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select></label>';
    }
    b += '<label class="field"><span>地點</span><input type="text" id="ge-loc" value="' + esc(e.location || '') + '" ' + D + '></label>';
    b += '<div class="field"><span>與會者' + (can ? '（儲存後 Google 會寄邀請）' : '') + '</span><div class="jx-att">' +
      [...memberMails.values()].map((m) => { const a = att.find((z) => String(z.email).toLowerCase() === m.email.toLowerCase()); return '<label class="jx-ach' + (picked.has(m.email.toLowerCase()) ? ' on' : '') + '"><input type="checkbox" class="ge-m" value="' + esc(m.email) + '" ' + (picked.has(m.email.toLowerCase()) ? 'checked' : '') + ' ' + D + ' data-jxf="geM">' + esc(m.name) + (a && a.rs ? ' ' + (rsI[a.rs] || '') : '') + '</label>'; }).join('') +
      '</div><input type="text" id="ge-other" value="' + esc(others.join(', ')) + '" ' + D + ' placeholder="其他人的 Email，用逗號分開"></div>';
    if (e.meet) b += '<div class="jx-meet">🎥 <a href="' + esc(J().safeUrl(e.meet)) + '" target="_blank" rel="noopener">' + esc(e.meet.replace(/^https:\/\//, '')) + '</a></div>';
    else if (can) b += '<label class="inline"><input type="checkbox" id="ge-meet"> 加上 Google Meet 視訊連結</label>';
    b += '<label class="field"><span>說明</span><textarea id="ge-desc" rows="3" ' + D + '>' + esc(String(e.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')) + '</textarea></label>';
    if (can && att.some((a) => !a.self)) b += '<label class="inline"><input type="checkbox" id="ge-notify" checked> 寄更新通知給與會者</label>';
    if (e.recurring && can) b += '<p class="hint" style="margin:0">🔁 這是重複活動，這裡只會修改這一次。</p>';
    if (company && can) b += '<p class="hint" style="margin:0">🏢 這是公司行事曆上的活動，修改後大家都會看到。</p>';
    // RSVP
    let rs = '';
    if (!x.isNew && !x.ro && e.rs && !e.mine) rs = '<div class="jx-rsvp"><span class="hint">回覆：</span>' + [['accepted', '接受'], ['tentative', '也許'], ['declined', '拒絕']].map(([k, l]) => '<button class="btn sm" data-jx="rsvp" data-v="' + k + '" aria-pressed="' + (e.rs === k) + '">' + l + '</button>').join('') + '</div>';
    b += rs;
    const link = J().safeUrl(e.link || e.htmlLink);
    let f = '';
    if (!x.isNew && can) f += '<button class="btn ghost danger" data-jx="gdel" style="margin-right:auto">刪除</button>';
    else f += '<span style="margin-right:auto"></span>';
    if (!x.isNew) f += '<button class="btn" data-jx="grec" title="用這個會議開始錄音">⏺ 錄音</button>';
    if (link) f += '<a class="btn" href="' + esc(link) + '" target="_blank" rel="noopener">在 Google 開啟</a>';
    f += can ? '<button class="btn primary" data-jx="gsave">' + (x.isNew ? '新增' : '儲存') + '</button>' : '<button class="btn" data-jx="close">關閉</button>';
    modal(x.isNew ? '新增活動' : '活動', b, f);
  }
  function readEdit() {
    const v = (id) => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
    const allDay = !!v('ge-all');
    const atts = [...document.querySelectorAll('.ge-m:checked')].map((el) => el.value);
    String(v('ge-other') || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean).forEach((s) => atts.push(s));
    const my = me(); if (atts.length && my && my.email && !atts.includes(my.email)) atts.unshift(my.email);
    return { summary: v('ge-sum') || '', date: v('ge-d0'), endDate: allDay ? v('ge-d1') : '', allDay, startTime: v('ge-t0'), endTime: v('ge-t1'), location: v('ge-loc') || '', description: v('ge-desc') || '', attendees: atts, meet: !!v('ge-meet'), notify: v('ge-notify') !== false };
  }
  async function saveEdit() {
    const x = G.edit; if (!x) return;
    const ev = readEdit();
    if (!ev.date) { toast('請選日期'); return; }
    if (!ev.allDay && (!ev.startTime || !ev.endTime)) { toast('請填開始和結束時間'); return; }
    const bad = ev.attendees.filter((s) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)); if (bad.length) { toast('Email 格式不對：' + bad[0]); return; }
    const cal = x.isNew ? (document.getElementById('ge-cal') || {}).value || x.cal : x.cal;
    const btn = host().querySelector('[data-jx="gsave"]'); if (btn) { btn.disabled = true; btn.textContent = '儲存中…'; }
    const r = await call('gcal', { mode: 'save', cal, id: x.id || undefined, ev });
    if (!r.ok) { if (btn) { btn.disabled = false; btn.textContent = '儲存'; } toast(r.error === 'forbidden' ? '你沒有這個日曆的編輯權限' : r.error === 'reauth' ? 'Google 授權過期，請重新連結' : '儲存失敗：' + (r.detail || r.error)); return; }
    closeModal(); G.edit = null; toast(x.isNew ? '已新增到 Google 日曆' : '已更新');
    if (S().compR && (S().compCals || []).some((c) => c.id === cal)) { S().compR = null; S().company = null; }
    invalidate();
  }
  async function delEdit() {
    const x = G.edit; if (!x || !confirm('刪除這個活動？' + ((x.e && (x.e.attendees || []).length > 1) ? '與會者會收到取消通知。' : ''))) return;
    const r = await call('gcal', { mode: 'delete', cal: x.cal, id: x.id });
    if (!r.ok) { toast('刪除失敗：' + (r.detail || r.error)); return; }
    closeModal(); G.edit = null; toast('已刪除');
    if ((S().compCals || []).some((c) => c.id === x.cal)) { S().compR = null; S().company = null; }
    invalidate();
  }
  async function rsvp(v) {
    const x = G.edit; if (!x) return;
    const r = await call('gcal', { mode: 'rsvp', cal: x.cal, id: x.id, rs: v });
    if (!r.ok) { toast('回覆失敗'); return; }
    x.e = { ...x.e, rs: v }; drawEdit(); toast('已回覆'); invalidate();
  }
  function recFromEvent() {
    const x = G.edit; if (!x) return; const e = x.e || {};
    const names = (e.attendees || []).map((a) => { const m = J().activeMembers().find((z) => z.email && z.email.toLowerCase() === String(a.email).toLowerCase()); return m ? m.name : (a.name || ''); }).filter(Boolean);
    G.edit = null;
    const mails = new Set(J().activeMembers().map((z) => String(z.email || '').toLowerCase()).filter(Boolean));
    const external = (e.attendees || []).some((a) => a.email && !mails.has(String(a.email).toLowerCase()) && !/vwsicamp\.com$|vwsi\.campmanagement/i.test(a.email));
    openStart({ title: e.summary || '', people: names, eventId: x.id, eventCal: x.cal, source: e.meet && !isMob() ? 'tab' : 'mic', external });
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', async (ev) => {
    const a = ev.target.closest('[data-jx]'); if (!a) return;
    const k = a.dataset.jx, id = a.dataset.id;
    if (a.tagName === 'SELECT' || (a.tagName === 'INPUT' && a.type !== 'button')) return;
    switch (k) {
      case 'close': closeModal(); G.edit = null; break;
      case 'start': openStart({}); break;
      case 'go': {
        const t = (document.getElementById('jx-title') || {}).value || ((M.startOpts || {}).into ? '' : '');
        const src = (document.querySelector('input[name="jx-src"]:checked') || {}).value || 'mic';
        const type = (document.querySelector('input[name="jx-type"]:checked') || {}).value || ((M.startOpts || {}).into ? (M.list[M.startOpts.into] || {}).type : '') || 'general';
        a.disabled = true;
        const manual = !!(document.getElementById('jx-manual') || {}).checked; try { localStorage.setItem('jj-manual', manual ? '1' : '0'); } catch (_) {}
        await startRec({ ...(M.startOpts || {}), title: t, source: src, type, manual });
        a.disabled = false; break;
      }
      case 'pause': pauseRec(); break;
      case 'transcribe': await S().db.doc('meetings/' + id).update({ status: 'processing', manual: false }); Object.assign(M.list[id], { status: 'processing', manual: false }); process(id, { notify: true, resum: true }); toast('開始轉逐字稿，完成後會通知你'); J().render(); break;
      case 'notes': M.notesOpen = !M.notesOpen; drawBar(); if (M.notesOpen) setTimeout(() => document.getElementById('jxNotesTa')?.focus(), 30); break;
      case 'notesT': { const ta = document.getElementById('jxNotesTa'); if (!ta || !M.rec) break; const tag = '[' + mmss(totalElapsed(M.rec)) + '] '; const p = ta.selectionStart ?? ta.value.length; const pre = ta.value.slice(0, p); const ins = (pre && !pre.endsWith('\n') ? '\n' : '') + tag; ta.value = pre + ins + ta.value.slice(p); ta.selectionStart = ta.selectionEnd = p + ins.length; ta.focus(); saveNotes(M.rec.id, ta.value); break; }
      case 'recMore': if (M.rec) { toast('正在錄另一場，請先結束'); break; } openStart({ into: id, source: (M.list[id] || {}).source === 'tab' ? 'tab' : 'mic' }); break;
      case 'stop': if (confirm('結束錄音並開始整理？')) stopRec(); break;
      case 'retryUp': if (M.done) retryFailed(M.done); break;
      case 'openMeet': M.sel = id; M.tab = 'tx'; location.hash = 'meet'; break;
      case 'sel': M.sel = id; M.confirmDel = null; J().render(); if (isMob()) scrollTo(0, 0); break;
      case 'unsel': M.sel = null; J().render(); break;
      case 'tab': M.tab = a.dataset.v; J().render(); break;
      case 'resume': process(id, { force: !!a.dataset.force }); J().render(); break;
      case 'resum': process(id, { resum: true }); toast('重新整理重點中…'); break;
      case 'retx': if (!confirm('用原始錄音重新轉逐字稿，並重新整理重點？')) break; process(id, { redo: true, resum: true, notify: true }); toast('重新轉錄中，完成後會通知你'); J().render(); break;
      case 'finish': await S().db.doc('meetings/' + id).update({ status: 'processing' }); M.list[id].status = 'processing'; process(id, { notify: true }); break;
      case 'unshare': { const m = M.list[id]; const sh = (m.shared || []).filter((x) => x !== a.dataset.m); await J().W(S().db.doc('meetings/' + id).update({ shared: sh })); break; }
      case 'askDel': M.confirmDel = id; J().render(); break;
      case 'delNo': M.confirmDel = null; J().render(); break;
      case 'del': delMeeting(id); break;
      case 'copy': copy(summaryText(M.list[id])); break;
      case 'copyTx': copy(txText(M.list[id])); break;
      case 'dlTx': { const m = M.list[id]; const blob = new Blob([summaryText(m) + '\n\n———— 逐字稿 ————\n' + txText(m)], { type: 'text/plain;charset=utf-8' }); const u = URL.createObjectURL(blob); const l = document.createElement('a'); l.href = u; l.download = (m.title || '會議') + '_' + (m.date || '') + '.txt'; l.click(); setTimeout(() => URL.revokeObjectURL(u), 2000); break; }
      case 'slack': { const ch = (document.getElementById('jx-slack') || {}).value; if (!ch) break; M.slackCh = ch; a.disabled = true; const ok = await J().slackSend(ch, summaryText(M.list[id]).slice(0, 3400)); a.disabled = false; if (ok) toast('已傳到 Slack'); break; }
      case 'play': play(M.list[id], Number(a.dataset.t)); break;
      case 'toTodo': {
        const m = M.list[id], i = Number(a.dataset.i), t = m.summary.todos[i], s = (m.todoState || {})[i] || {};
        const due = s.due !== undefined ? s.due : t.due;
        if (await J().W(S().db.collection('todos').add({ owner: me().id, title: t.text, date: due || '', done: false, createdAt: nowISO(), notes: '來自會議：' + esc(m.title || '') }), '已加入我的待辦')) setTodoState(m, i, { added: 'todo' });
        break;
      }
      case 'toTask': {
        const m = M.list[id], i = Number(a.dataset.i), t = m.summary.todos[i], s = (m.todoState || {})[i] || {};
        const pid = (document.getElementById('jx-tdproj') || {}).value || M.tdProj;
        if (!pid) { toast('先在上面選擇要加到哪個專案'); document.getElementById('jx-tdproj')?.focus(); break; }
        const p = S().projects[pid]; const mm = s.owner ? S().members[s.owner] : memberByName(t.owner);
        const due = s.due !== undefined ? s.due : t.due;
        const ok = await J().W(S().db.collection('tasks').add({ projectId: p.id, dept: p.dept, code: '', title: t.text, desc: '來自會議「' + (m.title || '') + '」（' + (m.date || '') + '）', owner: mm ? mm.id : '', collab: [], due: due || '', status: 'todo', progress: 0, phase: false, order: Object.keys(S().tasks).length, createdAt: nowISO(), updatedAt: nowISO() }), '已加入「' + p.name + '」');
        if (ok) setTodoState(m, i, { added: 'task', project: pid });
        break;
      }
      // 日曆
      case 'gset': gSettings(); break;
      case 'gconn': connect(); break;
      case 'gdisc': disconnect(); break;
      case 'gopen': ev.stopPropagation(); openEvent(a.dataset.cal, id); break;
      case 'gnew': openEvent('', '', a.dataset.day); break;
      case 'gsave': saveEdit(); break;
      case 'gdel': delEdit(); break;
      case 'rsvp': rsvp(a.dataset.v); break;
      case 'grec': recFromEvent(); break;
    }
  });
  document.addEventListener('change', async (ev) => {
    const el = ev.target;
    if (el.id === 'jx-file' || el.id === 'jx-file2' || el.id === 'jx-fileAdd') {
      const fs = [...(el.files || [])];
      let o = M.startOpts ? { ...M.startOpts, title: (document.getElementById('jx-title') || {}).value || '', type: (document.querySelector('input[name="jx-type"]:checked') || {}).value } : {};
      if (el.id === 'jx-fileAdd') o = { into: el.dataset.id };
      el.value = ''; if (fs.length) uploadFiles(fs, o); return;
    }
    if (el.id === 'jx-tdproj') { M.tdProj = el.value; return; }
    if (el.id === 'jx-micsel') { try { localStorage.setItem('jj-mic', el.value); } catch (_) {} startTest(); return; }
    if (el.id === 'jx-slack') { M.slackCh = el.value; return; }
    const k = el.dataset && el.dataset.jxf; if (!k) return;
    const id = el.dataset.id; const m = M.list[id];
    if (k === 'title') { const v = el.value.trim(); if (v && v !== m.title) await J().W(S().db.doc('meetings/' + id).update({ title: v, autoTitle: false }), '已改名'); }
    else if (k === 'type') {
      m.type = el.value;
      await J().W(S().db.doc('meetings/' + id).update({ type: el.value }), '已改成「' + typeLabel(el.value) + '」');
      if (m.summary && m.status !== 'recording') { process(id, { resum: true }); toast('用「' + typeLabel(el.value) + '」的格式重新整理中…'); }
    }
    else if (k === 'share' && el.value) { const sh = [...new Set([...(m.shared || []), el.value])]; const nm = (S().members[el.value] || {}).name; await J().W(S().db.doc('meetings/' + id).update({ shared: sh }), '已分享給 ' + nm); }
    else if (k === 'spk') { const sp = { ...(m.speakers || {}) }; const v = el.value.trim(); if (v) sp[el.dataset.l] = v; else delete sp[el.dataset.l]; m.speakers = sp; await J().W(S().db.doc('meetings/' + id).update({ speakers: sp })); }
    else if (k === 'tdOwner') setTodoState(m, Number(el.dataset.i), { owner: el.value });
    else if (k === 'tdDue') setTodoState(m, Number(el.dataset.i), { due: el.value });
    else if (k === 'gcal') { const v = [...document.querySelectorAll('[data-jxf="gcal"]:checked')].map((x) => x.value); try { localStorage.setItem('jj-gcals', JSON.stringify(v)); } catch (_) {} G.ev = null; J().render(); }
    else if (k === 'geAll') { const x = G.edit; if (!x) return; const cur = readEdit(); if (cur.startTime) { x._t0 = cur.startTime; x._t1 = cur.endTime; } x.e = { ...x.e, ...curToEv(cur) }; drawEdit(); }
    else if (k === 'geM') el.closest('label').classList.toggle('on', el.checked);
    else if (k === 'geT0') { const t1 = document.getElementById('ge-t1'); if (t1 && el.value && (!t1.value || t1.value <= el.value)) { const [h, mi] = el.value.split(':').map(Number); t1.value = pad(Math.min(23, h + 1)) + ':' + pad(mi); } }
  });
  function curToEv(c) {
    // 切換「整天」時保留目前填的內容
    const x = G.edit; const keep = { summary: c.summary, location: c.location, description: c.description, attendees: c.attendees.map((e) => ({ email: e })) };
    if (c.allDay) return { ...keep, start: { date: c.date }, end: { date: J().addDays(c.endDate && c.endDate >= c.date ? c.endDate : c.date, 1) } };
    return { ...keep, start: { dateTime: c.date + 'T' + (x._t0 || '09:00') }, end: { dateTime: c.date + 'T' + (x._t1 || '10:00') } };
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && host().innerHTML) { closeModal(); G.edit = null; }
    if (e.key === 'Enter' && e.target.id === 'jx-title') host().querySelector('[data-jx="go"]')?.click();
  });

  function boot() {
    subscribe();
    gStatus();
    let f = document.getElementById('jxFab');
    if (!f) {
      f = document.createElement('button'); f.id = 'jxFab'; f.className = 'jx-fab'; f.type = 'button'; f.dataset.jx = 'start';
      f.setAttribute('aria-label', '開始錄音'); f.title = '開始錄音（會議記錄）';
      f.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>';
      document.body.appendChild(f);
    }
    drawBar();
  }

  window.JX = {
    boot, view: viewMeet,
    gcOn: () => !!(G.st && G.st.connected), loadWeek, dayEvents, dayEventItems, weekToolbar, gStatus,
    settingsPanel: () => '<div class="panel-b pad"><p class="sub" style="margin:0 0 8px">用自己的 Google 帳號授權後，可以在工作台新增、修改活動，邀請與會者。</p>' + (G.st && G.st.connected ? '<span class="calst ok">已連結 ' + esc(G.st.email || '') + '</span> ' : '') + '<button class="btn sm" data-jx="gset">' + (G.st && G.st.connected ? '管理' : '連結 Google 日曆') + '</button></div>',
    _M: M, _G: G,
  };
})();
