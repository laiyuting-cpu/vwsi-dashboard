// 公用信箱未讀提醒：上方 ✉️、信件清單、靜音、電腦通知；設定頁（管理員）連結信箱與權限。
// 依賴 index.html 的 window.JJ。對外提供 window.JM。
(function () {
  'use strict';
  const SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly';
  const J = () => window.JJ;
  const S = () => window.JJ.S;
  const esc = (s) => window.JJ.esc(s);
  const toast = (m) => window.JJ.toast(m);
  const me = () => window.JJ.me();
  const ST = { boxes: {}, msgs: {}, mutes: new Set(), open: false, st: null, gis: null, known: null, loaded: false };

  async function call(body) {
    try {
      const { data, error } = await S().sb.functions.invoke('mail', { body });
      if (error) { try { return await error.context.json(); } catch (_) { return { ok: false, error: 'network' }; } }
      return data || { ok: false };
    } catch (e) { return { ok: false, error: 'network' }; }
  }
  const gmailUrl = (box, thread) => 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(box) + (thread ? '#all/' + encodeURIComponent(thread) : '#inbox');
  const ago = (iso) => {
    const d = (Date.now() - new Date(iso)) / 60000;
    if (d < 1) return '剛剛'; if (d < 60) return Math.round(d) + ' 分鐘前'; if (d < 1440) return Math.round(d / 60) + ' 小時前';
    return J().fmtD(new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 10)).split(' ')[0];
  };
  const visible = () => Object.values(ST.boxes).sort((a, b) => (a.private ? 1 : 0) - (b.private ? 1 : 0) || String(a.label || a.id).localeCompare(String(b.label || b.id)));
  const count = () => visible().filter((b) => !ST.mutes.has(b.id)).reduce((n, b) => n + (ST.msgs[b.id] || []).length, 0);

  /* ---------- 資料 ---------- */
  async function loadMsgs() {
    const { data } = await S().sb.from('mail_msgs').select('mailbox,id,thread,from_name,from_addr,subject,snippet,at').order('at', { ascending: false }).limit(500);
    const by = {};
    (data || []).forEach((r) => { (by[r.mailbox] = by[r.mailbox] || []).push(r); });
    ST.msgs = by;
    if (ST.known === null) ST.known = new Set((data || []).map((r) => r.mailbox + '|' + r.id));
    draw();
  }
  async function loadMutes() {
    const { data } = await S().sb.from('mail_mutes').select('mailbox');
    ST.mutes = new Set((data || []).map((r) => r.mailbox));
    draw();
  }
  function subscribe() {
    S().db.collection('mailboxes').onSnapshot((s) => {
      s.docChanges().forEach((c) => { if (c.type === 'removed') delete ST.boxes[c.doc.id]; else ST.boxes[c.doc.id] = { id: c.doc.id, ...c.doc.data() }; });
      ST.loaded = true; draw(); if (S().view === 'settings') J().render();
    }, () => {});
    let t = 0;
    S().sb.channel('mail-msgs').on('postgres_changes', { event: '*', schema: 'public', table: 'mail_msgs' }, (p) => {
      if (p.eventType === 'INSERT' && p.new) notifyNew(p.new);
      clearTimeout(t); t = setTimeout(loadMsgs, 400);
    }).subscribe();
    loadMsgs(); loadMutes();
  }
  function notifyNew(r) {
    const key = r.mailbox + '|' + r.id;
    if (!ST.known || ST.known.has(key)) return; ST.known.add(key);
    if (ST.mutes.has(r.mailbox) || !ST.boxes[r.mailbox]) return;
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification('✉️ ' + (ST.boxes[r.mailbox].label || r.mailbox), { body: (r.from_name || '') + '：' + (r.subject || ''), tag: key });
        n.onclick = () => { window.open(gmailUrl(r.mailbox, r.thread), '_blank', 'noopener'); n.close(); };
      }
    } catch (_) {}
  }

  /* ---------- 上方 ✉️ ---------- */
  function draw() {
    const el = document.getElementById('mailbtn'); if (!el) return;
    const boxes = visible();
    if (!boxes.length && !(ST.st && ST.st.admin)) { el.innerHTML = ''; return; }
    const n = count();
    el.innerHTML = '<button type="button" class="mb-btn" data-jm="toggle" aria-haspopup="true" aria-expanded="' + ST.open + '" aria-label="信箱，' + n + ' 封未讀" title="公用信箱">✉️' + (n ? '<span class="mb-badge">' + (n > 99 ? '99+' : n) + '</span>' : '') + '</button>';
    if (ST.open) drawPanel();
  }
  function drawPanel() {
    let p = document.getElementById('mbpanel');
    if (!p) { p = document.createElement('div'); p.id = 'mbpanel'; p.className = 'mb-panel'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', '公用信箱'); document.body.appendChild(p); }
    const boxes = visible();
    let h = '<div class="mb-head"><b>公用信箱</b><span class="hint">近 7 天未讀</span><span style="flex:1"></span><button class="btn sm" data-jm="refresh" title="立刻檢查新信">↻</button>' + (ST.st && ST.st.admin ? '<a class="btn sm" href="#settings" data-jm="close">管理</a>' : '') + '<button class="btn sm ghost" data-jm="close" aria-label="關閉">✕</button></div>';
    if ('Notification' in window && Notification.permission === 'default') h += '<div class="mb-note">想在有新信時跳出電腦／手機通知嗎？<button class="btn sm" data-jm="perm">開啟通知</button></div>';
    if (!boxes.length) h += '<div class="empty">還沒有連結信箱。' + (ST.st && ST.st.admin ? '<br>到「設定 → 公用信箱」連結。' : '') + '</div>';
    h += '<div class="mb-list">' + boxes.map((b) => {
      const ms = ST.msgs[b.id] || []; const mu = ST.mutes.has(b.id);
      const warn = b.status === 'reauth' ? '<span class="mb-warn">需要重新連結</span>' : b.status === 'error' ? '<span class="mb-warn">讀取失敗</span>' : '';
      return '<section class="mb-box' + (mu ? ' muted' : '') + '"><div class="mb-bh"><a href="' + esc(gmailUrl(b.id)) + '" target="_blank" rel="noopener" title="在 Gmail 打開"><b>' + esc(b.label || b.id) + '</b><span class="hint">' + esc(b.id) + '</span></a>' + warn +
        '<span class="mb-n">' + (b.unread ? b.unread + ' 未讀' : '') + '</span><button class="mb-mute" data-jm="mute" data-id="' + esc(b.id) + '" aria-pressed="' + mu + '" title="' + (mu ? '已靜音：不提醒、不發 Slack，點一下取消' : '靜音這個信箱') + '">' + (mu ? '🔕' : '🔔') + '</button></div>' +
        (ms.length ? ms.slice(0, 5).map((m) => '<a class="mb-msg" href="' + esc(gmailUrl(b.id, m.thread)) + '" target="_blank" rel="noopener"><div class="mb-l1"><b>' + esc(m.from_name || m.from_addr) + '</b><span class="hint">' + esc(ago(m.at)) + '</span></div><div class="mb-sub">' + esc(m.subject) + '</div>' + (m.snippet ? '<div class="mb-snip">' + esc(m.snippet) + '</div>' : '') + '</a>').join('') + (ms.length > 5 ? '<a class="mb-more" href="' + esc(gmailUrl(b.id)) + '" target="_blank" rel="noopener">還有 ' + (ms.length - 5) + ' 封 →</a>' : '')
          : '<div class="mb-none">沒有未讀信件</div>') + '</section>';
    }).join('') + '</div><div class="mb-foot hint">點信件會在 Gmail 打開；瀏覽器要登入那個信箱才看得到。</div>';
    p.innerHTML = h;
    const btn = document.querySelector('.mb-btn');
    if (btn && !matchMedia('(max-width:760px)').matches) { const r = btn.getBoundingClientRect(); p.style.top = (r.bottom + 8) + 'px'; p.style.right = Math.max(8, innerWidth - r.right) + 'px'; p.style.left = 'auto'; }
  }
  function close() { ST.open = false; const p = document.getElementById('mbpanel'); if (p) p.remove(); draw(); }

  /* ---------- 設定頁（管理員） ---------- */
  function settingsPanel() {
    const st = ST.st || {};
    if (!st.admin) return '';
    const my = me(); const members = J().activeMembers().filter((m) => m.kind !== '主管');
    let h = '<div class="panel-b pad"><p class="sub" style="margin:0 0 10px">連結公用 Gmail 後，工作台每 5 分鐘檢查未讀信件，提醒看得到的夥伴（✉️、電腦通知、Slack 私訊）。只存寄件人、主旨和前兩行，讀過或超過 7 天就刪除。主管都看得到公用信箱。</p>';
    if (!st.ready) h += '<p class="hint">Google 授權還沒設定好（GOOGLE_OAUTH_CLIENT_ID）。</p>';
    h += Object.values(ST.boxes).sort((a, b) => String(a.id).localeCompare(String(b.id))).map((b) => {
      const priv = !!b.private; const mineP = priv && b.owner === my.id; const allow = b.allow || [];
      const stTxt = b.status === 'ok' ? '<span class="calst ok">正常' + (b.checkedAt ? '・' + esc(ago(b.checkedAt)) + '檢查' : '') + '</span>' : b.status === 'reauth' ? '<span class="calst bad">授權失效，請重新連結</span>' : '<span class="calst bad">' + esc(b.error || '讀取失敗') + '</span>';
      return '<div class="mb-set"><div class="mb-set-h"><input type="text" value="' + esc(b.label || '') + '" data-jmf="label" data-id="' + esc(b.id) + '" aria-label="' + esc(b.id) + ' 的顯示名稱" placeholder="顯示名稱" style="width:160px"><span class="mono">' + esc(b.id) + '</span>' + stTxt + '<span style="flex:1"></span>' +
        (b.status === 'reauth' ? '<button class="btn sm primary" data-jm="connect">重新連結</button>' : '') + '<button class="btn sm ghost danger" data-jm="disc" data-id="' + esc(b.id) + '">取消連結</button></div>' +
        '<label class="inline"><input type="checkbox" data-jmf="private" data-id="' + esc(b.id) + '" ' + (priv ? 'checked' : '') + (priv && !mineP ? ' disabled' : '') + '> 個人信箱（只有' + (priv ? esc((S().members[b.owner] || {}).name || '擁有者') : '我') + '看得到）</label>' +
        (priv ? '' : '<div class="mb-allow"><span class="hint">還有誰看得到：</span>' + members.map((m) => '<label class="jx-ach' + (allow.includes(m.id) ? ' on' : '') + '"><input type="checkbox" data-jmf="allow" data-id="' + esc(b.id) + '" value="' + esc(m.id) + '" ' + (allow.includes(m.id) ? 'checked' : '') + '>' + esc(m.name) + '</label>').join('') + '</div>') + '</div>';
    }).join('');
    h += '<div style="margin-top:12px"><button class="btn primary" data-jm="connect"' + (st.ready ? '' : ' disabled') + '>＋ 連結信箱</button> <span class="hint">會跳出 Google 視窗，請選擇（或登入）要連結的公用帳號。</span></div></div>';
    return h;
  }
  function loadGis() {
    if (ST.gis) return ST.gis;
    if (window.google && google.accounts && google.accounts.oauth2) return (ST.gis = Promise.resolve());
    ST.gis = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    ST.gis.catch(() => { ST.gis = null; });
    return ST.gis;
  }
  async function connect() {
    if (!ST.st || !ST.st.ready) { toast('Google 授權還沒設定好'); return; }
    if (!(window.google && google.accounts && google.accounts.oauth2)) { try { await loadGis(); } catch (_) { toast('無法載入 Google 登入'); return; } }
    google.accounts.oauth2.initCodeClient({
      client_id: ST.st.clientId, scope: SCOPE, ux_mode: 'popup', prompt: 'consent select_account',
      callback: async (r) => {
        if (r.error) { toast('沒有完成授權'); return; }
        toast('連結中…');
        const x = await call({ mode: 'connect', code: r.code });
        if (!x.ok) { toast(x.error === 'scope_missing' ? '要勾選「讀取 Gmail」的權限才能連結' : '連結失敗：' + (x.detail || x.error)); return; }
        toast('已連結 ' + x.email + (x.poll && x.poll.ok ? '' : '（讀取信件失敗，稍後會再試）'));
      },
      error_callback: (e) => { if (e && e.type !== 'popup_closed') toast('無法開啟授權視窗：請允許彈出式視窗'); },
    }).requestCode();
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', async (ev) => {
    const a = ev.target.closest('[data-jm]');
    if (!a) { if (ST.open && !ev.target.closest('#mbpanel')) close(); return; }
    const k = a.dataset.jm, id = a.dataset.id;
    if (k === 'toggle') { ST.open = !ST.open; if (!ST.open) close(); else { draw(); call({ mode: 'refresh' }); } return; }
    if (k === 'close') { close(); return; }
    if (k === 'refresh') { a.disabled = true; const r = await call({ mode: 'refresh' }); a.disabled = false; await loadMsgs(); toast(r.ok ? '已檢查新信' : '檢查失敗'); return; }
    if (k === 'perm') { try { await Notification.requestPermission(); } catch (_) {} drawPanel(); return; }
    if (k === 'mute') {
      const my = me(); if (!my) return;
      if (ST.mutes.has(id)) { await S().sb.from('mail_mutes').delete().eq('mid', my.id).eq('mailbox', id); ST.mutes.delete(id); toast('已取消靜音'); }
      else { await S().sb.from('mail_mutes').insert({ mid: my.id, mailbox: id }); ST.mutes.add(id); toast('已靜音：這個信箱不會再提醒你'); }
      draw(); return;
    }
    if (k === 'connect') { connect(); return; }
    if (k === 'disc') {
      if (!confirm('取消連結 ' + id + '？工作台會刪掉這個信箱的提醒資料（Gmail 裡的信不受影響）。')) return;
      const r = await call({ mode: 'disconnect', id });
      if (r.ok) { delete ST.boxes[id]; toast('已取消連結'); J().render(); } else toast('失敗：' + (r.error || ''));
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ST.open) close(); });
  document.addEventListener('change', async (ev) => {
    const el = ev.target; const k = el.dataset && el.dataset.jmf; if (!k) return;
    const id = el.dataset.id; const b = ST.boxes[id]; if (!b) return;
    let patch = null;
    if (k === 'label') patch = { label: el.value.trim() || id.split('@')[0] };
    else if (k === 'private') patch = el.checked ? { private: true, owner: me().id, allow: [] } : { private: false };
    else if (k === 'allow') { const s = new Set(b.allow || []); el.checked ? s.add(el.value) : s.delete(el.value); patch = { allow: [...s] }; el.closest('label').classList.toggle('on', el.checked); }
    if (patch) { Object.assign(b, patch); await J().W(S().db.doc('mailboxes/' + id).update(patch), '已儲存'); if (k === 'private') J().render(); }
  });
  addEventListener('resize', () => { if (ST.open) drawPanel(); });
  addEventListener('hashchange', () => { if (ST.open) close(); });

  async function boot() {
    let h = document.getElementById('mailbtn');
    if (!h) { h = document.createElement('div'); h.id = 'mailbtn'; const who = document.getElementById('who'); who && who.parentNode.insertBefore(h, who); }
    subscribe();
    const r = await call({ mode: 'status' });
    ST.st = r.ok ? r : { admin: false, ready: false };
    draw(); if (S().view === 'settings') J().render();
    setInterval(loadMsgs, 5 * 60e3);
  }
  window.JM = { boot, settingsPanel, _ST: ST };
})();
