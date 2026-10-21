// 把 Supabase 包成工作台原本使用的文件式介面：
//   db.collection(name).where(field, op, value).onSnapshot(cb)
//   db.collection(name).add(obj) / .doc(id)
//   db.doc('name/id').get() / set() / update() / delete()
// 每張表的欄位都是 (id text, data jsonb)。
(function () {
  'use strict';
  const TABLES = new Set(['members', 'depts', 'projects', 'tasks', 'templates', 'goals', 'manuals', 'todos', 'daily', 'comments', 'prefs']);
  const genId = () => { const a = new Uint8Array(15); crypto.getRandomValues(a); return Array.from(a, b => (b % 36).toString(36)).join('').slice(0, 20); };
  const clean = o => JSON.parse(JSON.stringify(o === undefined ? null : o));

  function toErr(e) {
    const msg = (e && (e.message || e.details)) || '未知錯誤';
    const denied = /row-level security|not_found_or_denied|permission denied|42501/i.test(msg + ' ' + (e && e.code));
    const err = new Error(denied ? '沒有權限修改這筆資料' : msg);
    err.code = denied ? 'permission_denied' : (e && e.code) || 'unknown';
    return err;
  }
  function resolvePath(path) {
    const s = String(path).split('/');
    if (s[0] === 'data' && s[1] === 'users') return ['prefs', s[2]];
    if (!TABLES.has(s[0])) throw new Error('unknown collection ' + s[0]);
    return [s[0], s[1]];
  }
  const snapDoc = (id, data) => ({ id, exists: data !== undefined && data !== null, data: () => (data == null ? undefined : data) });

  function makeDb(sb) {
    // 每張表共用一條即時頻道
    const channels = {};
    const listeners = {};
    function channelFor(tbl) {
      if (channels[tbl]) return;
      listeners[tbl] = new Set();
      channels[tbl] = sb.channel('rt-' + tbl)
        .on('postgres_changes', { event: '*', schema: 'public', table: tbl }, payload => {
          listeners[tbl].forEach(l => l.onChange(payload));
        })
        .subscribe(status => { if (status === 'SUBSCRIBED') listeners[tbl].forEach(l => l.resync()); });
    }

    // 寫入成功後立刻更新本機畫面，不必等即時通知（App 模式或輸入框還在焦點時也會馬上出現）
    function echo(tbl, payload) { (listeners[tbl] || []).forEach(l => { try { l.onChange(payload); } catch (_) {} }); }
    function echoPatch(tbl, id, patch) { (listeners[tbl] || []).forEach(l => { try { l.patch(id, patch); } catch (_) {} }); }

    function docRef(tbl, id) {
      return {
        id,
        async get() {
          const { data, error } = await sb.from(tbl).select('id,data').eq('id', id).maybeSingle();
          if (error) throw toErr(error);
          return snapDoc(id, data ? data.data : undefined);
        },
        async set(obj) {
          const { error } = await sb.from(tbl).upsert({ id, data: clean(obj), updated_at: new Date().toISOString() });
          if (error) throw toErr(error);
          echo(tbl, { eventType: 'UPDATE', new: { id, data: clean(obj) } });
        },
        async update(patch) {
          const { error } = await sb.rpc('doc_patch', { tbl, doc_id: id, patch: clean(patch) });
          if (error) throw toErr(error);
          echoPatch(tbl, id, clean(patch));
        },
        async delete() {
          const { error } = await sb.from(tbl).delete().eq('id', id);
          if (error) throw toErr(error);
          echo(tbl, { eventType: 'DELETE', old: { id } });
        }
      };
    }

    function matches(data, filters) {
      return filters.every(([f, op, v]) => {
        const x = data == null ? undefined : data[f];
        if (op === '==') return x === v;
        if (op === 'in') return Array.isArray(v) && v.includes(x);
        return true;
      });
    }

    async function fetchAll(tbl, filters) {
      const out = [];
      for (let from = 0; ; from += 1000) {
        let q = sb.from(tbl).select('id,data').range(from, from + 999);
        for (const [f, op, v] of filters) {
          if (op === '==') q = q.eq('data->>' + f, String(v));
          else if (op === 'in') q = q.in('data->>' + f, v.map(String));
        }
        const { data, error } = await q;
        if (error) throw toErr(error);
        out.push(...data);
        if (data.length < 1000) break;
      }
      return out;
    }

    function query(tbl, filters) {
      return {
        where(f, op, v) { return query(tbl, [...filters, [f, op, v]]); },
        doc(id) { return docRef(tbl, id || genId()); },
        async add(obj) {
          const id = genId();
          const { error } = await sb.from(tbl).insert({ id, data: clean(obj) });
          if (error) throw toErr(error);
          echo(tbl, { eventType: 'INSERT', new: { id, data: clean(obj) } });
          return { id };
        },
        onSnapshot(cb, errCb) {
          const map = new Map();
          let alive = true, timer = null;
          const emit = changes => { if (!alive) return; const docs = [...map].map(([id, d]) => snapDoc(id, d)); cb({ docs, size: docs.length, empty: !docs.length, docChanges: () => changes }); };
          const resync = async () => {
            try {
              const rows = await fetchAll(tbl, filters);
              const seen = new Set(); const ch = [];
              for (const r of rows) {
                seen.add(r.id);
                const prev = map.get(r.id);
                if (prev === undefined) ch.push({ type: 'added', doc: snapDoc(r.id, r.data) });
                else if (JSON.stringify(prev) !== JSON.stringify(r.data)) ch.push({ type: 'modified', doc: snapDoc(r.id, r.data) });
                map.set(r.id, r.data);
              }
              for (const id of [...map.keys()]) if (!seen.has(id)) { ch.push({ type: 'removed', doc: snapDoc(id, map.get(id)) }); map.delete(id); }
              if (ch.length || !listener.loaded) { listener.loaded = true; emit(ch); }
            } catch (e) { console.error(e); if (errCb) errCb(e); }
          };
          const listener = {
            loaded: false,
            resync: () => { clearTimeout(timer); timer = setTimeout(resync, 150); },
            patch(id, patch) { if (!map.has(id)) return; const d = Object.assign({}, map.get(id), patch); this.onChange({ eventType: 'UPDATE', new: { id, data: d } }); },
            onChange(p) {
              if (p.eventType === 'DELETE') {
                const id = p.old && p.old.id;
                if (id && map.has(id)) { const d = map.get(id); map.delete(id); emit([{ type: 'removed', doc: snapDoc(id, d) }]); }
                return;
              }
              const row = p.new; if (!row || !row.id) return;
              const ok = matches(row.data, filters);
              if (ok) { const t = map.has(row.id) ? 'modified' : 'added'; map.set(row.id, row.data); emit([{ type: t, doc: snapDoc(row.id, row.data) }]); }
              else if (map.has(row.id)) { const d = map.get(row.id); map.delete(row.id); emit([{ type: 'removed', doc: snapDoc(row.id, d) }]); }
            }
          };
          channelFor(tbl);
          listeners[tbl].add(listener);
          resync();
          return () => { alive = false; listeners[tbl].delete(listener); };
        }
      };
    }

    // 回到分頁或網路恢復時重新對齊，避免漏掉離線期間的修改
    const resyncAll = () => Object.values(listeners).forEach(set => set.forEach(l => l.resync()));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resyncAll(); });
    window.addEventListener('online', resyncAll);

    return {
      collection(name) { if (!TABLES.has(name)) throw new Error('unknown collection ' + name); return query(name, []); },
      doc(path) { const [t, id] = resolvePath(path); return docRef(t, id); }
    };
  }

  function makeAssets(sb, uid, bucket) {
    return {
      async upload(blob, opt) {
        const type = (opt && opt.type) || blob.type || 'image/jpeg';
        const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
        const path = uid + '/' + Date.now().toString(36) + '.' + ext;
        const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: type, upsert: false, cacheControl: '31536000' });
        if (error) throw toErr(error);
        return { id: path, url: sb.storage.from(bucket).getPublicUrl(path).data.publicUrl };
      },
      url(id) { return id && id.includes('/') ? sb.storage.from(bucket).getPublicUrl(id).data.publicUrl : ''; }
    };
  }

  window.VW = { makeDb, makeAssets };
})();
