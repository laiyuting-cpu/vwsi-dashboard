-- 職掘工作台 · 會議記錄＋個人 Google 日曆授權（2026-11）
-- 在 schema.sql 之後執行。可以重複執行。

-- ---------- 會議 ----------
create table if not exists public.meetings (
  id text primary key default replace(gen_random_uuid()::text,'-',''),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists meetings_owner_idx on public.meetings ((data->>'owner'));
alter table public.meetings enable row level security;
revoke all on public.meetings from anon;
grant select, insert, update, delete on public.meetings to authenticated, service_role;

-- 錄的人與被分享的人看得到
create or replace function public.can_see_meeting(mid text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member() and exists (
    select 1 from public.meetings m where m.id = mid
      and (m.data->>'owner' = public.my_member_id() or coalesce(m.data->'shared','[]'::jsonb) ? public.my_member_id()))
$$;
create or replace function public.owns_meeting(mid text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member() and exists (select 1 from public.meetings m where m.id = mid and m.data->>'owner' = public.my_member_id())
$$;
revoke execute on function public.can_see_meeting(text) from public, anon;
revoke execute on function public.owns_meeting(text) from public, anon;
grant execute on function public.can_see_meeting(text) to authenticated, service_role;
grant execute on function public.owns_meeting(text) to authenticated, service_role;

drop policy if exists r on public.meetings;
drop policy if exists w on public.meetings;
drop policy if exists u on public.meetings;
drop policy if exists d on public.meetings;
create policy r on public.meetings for select to authenticated using (
  public.is_member() and (data->>'owner' = public.my_member_id() or coalesce(data->'shared','[]'::jsonb) ? public.my_member_id()));
create policy w on public.meetings for insert to authenticated with check (public.is_member() and data->>'owner' = public.my_member_id());
create policy u on public.meetings for update to authenticated using (data->>'owner' = public.my_member_id()) with check (data->>'owner' = public.my_member_id());
create policy d on public.meetings for delete to authenticated using (data->>'owner' = public.my_member_id());

-- 逐字稿分段：只有後端（meeting 函式）寫入
create table if not exists public.meeting_segs (
  meeting_id text not null references public.meetings(id) on delete cascade,
  n int not null,
  status text not null default 'pending',
  lines jsonb not null default '[]'::jsonb,
  error text,
  updated_at timestamptz not null default now(),
  primary key (meeting_id, n)
);
alter table public.meeting_segs enable row level security;
revoke all on public.meeting_segs from anon;
grant select on public.meeting_segs to authenticated;
grant select, insert, update, delete on public.meeting_segs to service_role;
drop policy if exists r on public.meeting_segs;
create policy r on public.meeting_segs for select to authenticated using (public.can_see_meeting(meeting_id));

do $$ begin
  begin alter publication supabase_realtime add table public.meetings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.meeting_segs; exception when duplicate_object then null; end;
end $$;

create or replace function public.doc_patch(tbl text, doc_id text, patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  if tbl not in ('members','depts','projects','tasks','templates','goals','manuals','todos','daily','comments','prefs','gifts','leaves','meetings') then
    raise exception 'unknown table %', tbl;
  end if;
  execute format('update public.%I set data = data || $1, updated_at = now() where id = $2', tbl) using patch, doc_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'not_found_or_denied' using errcode = '42501'; end if;
end $$;
grant execute on function public.doc_patch(text, text, jsonb) to authenticated, service_role;

-- ---------- 音檔（私人） ----------
-- 路徑：<會議 id>/<段落>.<副檔名>
insert into storage.buckets (id, name, public, file_size_limit)
values ('meetings', 'meetings', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;
drop policy if exists "meetings insert" on storage.objects;
drop policy if exists "meetings select" on storage.objects;
drop policy if exists "meetings delete" on storage.objects;
drop policy if exists "meetings update" on storage.objects;
create policy "meetings insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'meetings' and public.owns_meeting(split_part(name, '/', 1)));
create policy "meetings select" on storage.objects for select to authenticated
  using (bucket_id = 'meetings' and public.can_see_meeting(split_part(name, '/', 1)));
create policy "meetings delete" on storage.objects for delete to authenticated
  using (bucket_id = 'meetings' and public.owns_meeting(split_part(name, '/', 1)));
create policy "meetings update" on storage.objects for update to authenticated
  using (bucket_id = 'meetings' and public.owns_meeting(split_part(name, '/', 1)))
  with check (bucket_id = 'meetings' and public.owns_meeting(split_part(name, '/', 1)));

-- ---------- 個人 Google 日曆授權 ----------
-- refresh token 先在函式裡加密才存進來；只有後端（service_role）能讀寫。
create table if not exists private.gtokens (
  mid text primary key,
  email text,
  enc text not null,
  scope text,
  updated_at timestamptz not null default now()
);
revoke all on private.gtokens from public, anon, authenticated;

create or replace function public.gtoken_get(p_mid text) returns jsonb
language sql stable security definer set search_path = private, public as $$
  select to_jsonb(t) from private.gtokens t where t.mid = p_mid
$$;
create or replace function public.gtoken_put(p_mid text, p_email text, p_enc text, p_scope text) returns void
language sql security definer set search_path = private, public as $$
  insert into private.gtokens (mid, email, enc, scope, updated_at) values (p_mid, p_email, p_enc, p_scope, now())
  on conflict (mid) do update set email = excluded.email, enc = excluded.enc, scope = excluded.scope, updated_at = now()
$$;
create or replace function public.gtoken_del(p_mid text) returns void
language sql security definer set search_path = private, public as $$
  delete from private.gtokens where mid = p_mid
$$;
revoke execute on function public.gtoken_get(text) from public, anon, authenticated;
revoke execute on function public.gtoken_put(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.gtoken_del(text) from public, anon, authenticated;
grant execute on function public.gtoken_get(text) to service_role;
grant execute on function public.gtoken_put(text, text, text, text) to service_role;
grant execute on function public.gtoken_del(text) to service_role;

-- ---------- 每天清掉 30 天前的音檔（逐字稿保留） ----------
do $$ begin
  perform cron.unschedule('meeting-cleanup');
exception when others then null; end $$;
select cron.schedule('meeting-cleanup', '23 19 * * *', $c$
  select net.http_post(
    url := 'https://pratgdxlgwgjchkvnaum.supabase.co/functions/v1/meeting',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select v from private.app_secrets where k='cron')),
    body := '{"mode":"cleanup"}'::jsonb)
$c$);
