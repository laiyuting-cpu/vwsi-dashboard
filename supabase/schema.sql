-- 職掘工作台 · Supabase schema
-- 在 Supabase 的 SQL Editor 貼上整份、按 Run。可以重複執行。

create extension if not exists pgcrypto;

-- ---------- 資料表：每張表都是 (id, data jsonb) ----------
do $$
declare t text;
begin
  foreach t in array array['members','depts','projects','tasks','templates','goals','manuals','todos','daily','comments','prefs'] loop
    execute format($f$
      create table if not exists public.%I (
        id text primary key default replace(gen_random_uuid()::text,'-',''),
        data jsonb not null default '{}'::jsonb,
        updated_at timestamptz not null default now()
      )$f$, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

create index if not exists tasks_project_idx  on public.tasks ((data->>'projectId'));
create index if not exists todos_owner_idx    on public.todos ((data->>'owner'));
create index if not exists daily_date_idx     on public.daily ((data->>'date'));
create index if not exists comments_target_idx on public.comments ((data->>'target'));
create index if not exists comments_day_idx   on public.comments ((data->>'day'));
create unique index if not exists members_email_idx on public.members (lower(data->>'email')) where coalesce(data->>'email','') <> '';

-- ---------- 身分與角色 ----------
create or replace function public.my_member_id() returns text
language sql stable security definer set search_path = public as $$
  select id from public.members
  where data->>'uid' = auth.uid()::text and coalesce((data->>'active')::boolean, true)
  limit 1
$$;

create or replace function public.my_kind() returns text
language sql stable security definer set search_path = public as $$
  select data->>'kind' from public.members where id = public.my_member_id()
$$;

create or replace function public.is_member() returns boolean
language sql stable as $$ select public.my_member_id() is not null $$;

create or replace function public.is_admin() returns boolean
language sql stable as $$ select coalesce(public.my_kind() = '主管', false) $$;

-- 正職、實習、主管（不含委外）
create or replace function public.is_staff() returns boolean
language sql stable as $$ select public.is_member() and coalesce(public.my_kind(), '') <> '委外' $$;

create or replace function public.leads_dept(d text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.depts where id = d and data->>'head' = public.my_member_id())
$$;

create or replace function public.can_struct_project(pid text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or public.leads_dept((select data->>'dept' from public.projects where id = pid))
$$;

-- 委外只看得到：自己負責或被加入的專案，以及自己有任務的專案
create or replace function public.can_see_project(pid text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff()
    or (public.is_member() and (
         exists (select 1 from public.projects p where p.id = pid
                 and (p.data->>'owner' = public.my_member_id() or coalesce(p.data->'members','[]'::jsonb) ? public.my_member_id()))
      or exists (select 1 from public.tasks t where t.data->>'projectId' = pid
                 and (t.data->>'owner' = public.my_member_id() or coalesce(t.data->'collab','[]'::jsonb) ? public.my_member_id()))
    ))
$$;

-- 登入後用 Email 自動對應名單裡的夥伴
create or replace function public.claim_me() returns text
language plpgsql security definer set search_path = public as $$
declare em text := lower(coalesce(auth.jwt()->>'email', '')); mid text;
begin
  if auth.uid() is null then return null; end if;
  select id into mid from public.members where data->>'uid' = auth.uid()::text limit 1;
  if mid is not null then return mid; end if;
  if em = '' then return null; end if;
  select id into mid from public.members
   where lower(data->>'email') = em and coalesce(data->>'uid','') = '' limit 1;
  if mid is null then return null; end if;
  perform set_config('app.claiming', '1', true);
  update public.members set data = jsonb_set(data, '{uid}', to_jsonb(auth.uid()::text)), updated_at = now() where id = mid;
  return mid;
end $$;
grant execute on function public.claim_me() to authenticated;

-- 非主管不能改自己的職級、部門、Email、綁定
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if auth.uid() is null or public.is_admin() or current_setting('app.claiming', true) = '1' then return new; end if;
  foreach k in array array['kind','dept','uid','email','active','order','role'] loop
    if old.data ? k then new.data := jsonb_set(new.data, array[k], old.data->k);
    else new.data := new.data - k; end if;
  end loop;
  return new;
end $$;
drop trigger if exists members_guard on public.members;
create trigger members_guard before update on public.members for each row execute function public.members_guard();

-- Firestore 式的部分更新：data = data || patch（受 RLS 管控）
create or replace function public.doc_patch(tbl text, doc_id text, patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  if tbl not in ('members','depts','projects','tasks','templates','goals','manuals','todos','daily','comments','prefs') then
    raise exception 'unknown table %', tbl;
  end if;
  execute format('update public.%I set data = data || $1, updated_at = now() where id = $2', tbl) using patch, doc_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'not_found_or_denied' using errcode = '42501'; end if;
end $$;
grant execute on function public.doc_patch(text, text, jsonb) to authenticated, service_role;

-- ---------- 權限規則 ----------
do $$
declare t text;
begin
  foreach t in array array['members','depts','projects','tasks','templates','goals','manuals','todos','daily','comments','prefs'] loop
    execute coalesce((select string_agg(format('drop policy if exists %I on public.%I;', policyname, t), ' ')
             from pg_policies where schemaname = 'public' and tablename = t), 'select 1');
  end loop;
end $$;

-- 名單、部門、範本、年度目標：成員都能看；主管能改
create policy r on public.members   for select to authenticated using (public.is_member());
create policy w on public.members   for insert to authenticated with check (public.is_admin());
create policy u on public.members   for update to authenticated using (public.is_admin() or id = public.my_member_id());
create policy d on public.members   for delete to authenticated using (public.is_admin());

create policy r on public.depts     for select to authenticated using (public.is_member());
create policy w on public.depts     for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy r on public.templates for select to authenticated using (public.is_member());
create policy w on public.templates for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy r on public.goals     for select to authenticated using (public.is_staff());
create policy w on public.goals     for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- 專案：主管與該部門主管能建立、修改、刪除
create policy r on public.projects  for select to authenticated using (public.can_see_project(id));
create policy w on public.projects  for insert to authenticated with check (public.is_admin() or public.leads_dept(data->>'dept'));
create policy u on public.projects  for update to authenticated using (public.can_struct_project(id) or (public.is_staff() and data->>'owner' = public.my_member_id()));
create policy d on public.projects  for delete to authenticated using (public.can_struct_project(id));

-- 任務：夥伴可以更新；委外只能更新自己負責或協作的任務
create policy r on public.tasks     for select to authenticated using (public.can_see_project(data->>'projectId'));
create policy w on public.tasks     for insert to authenticated with check (public.is_staff() or (data->>'owner' = public.my_member_id() and public.can_see_project(data->>'projectId')));
create policy u on public.tasks     for update to authenticated using (public.is_staff() or data->>'owner' = public.my_member_id() or coalesce(data->'collab','[]'::jsonb) ? public.my_member_id());
create policy d on public.tasks     for delete to authenticated using (public.can_struct_project(data->>'projectId'));

-- 個人待辦、三件事：本人能改；正職夥伴能看
create policy r on public.todos     for select to authenticated using (public.is_staff() or data->>'owner' = public.my_member_id());
create policy w on public.todos     for all    to authenticated using (data->>'owner' = public.my_member_id()) with check (data->>'owner' = public.my_member_id());

create policy r on public.daily     for select to authenticated using (public.is_staff() or data->>'memberId' = public.my_member_id());
create policy w on public.daily     for all    to authenticated using (data->>'memberId' = public.my_member_id()) with check (data->>'memberId' = public.my_member_id());

-- 留言與插隊
create policy r on public.comments  for select to authenticated using (
  public.is_staff() or data->>'byMember' = public.my_member_id()
  or data->>'target' like 'daily:%\_' || public.my_member_id()
  or (data->>'target' like 'task:%' and exists (select 1 from public.tasks t where 'task:' || t.id = data->>'target')));
create policy w on public.comments  for insert to authenticated with check (public.is_member() and data->>'byMember' = public.my_member_id());
create policy u on public.comments  for update to authenticated using (public.is_staff() or data->>'byMember' = public.my_member_id() or data->>'target' like 'daily:%\_' || public.my_member_id());
create policy d on public.comments  for delete to authenticated using (public.is_admin() or data->>'byMember' = public.my_member_id());

-- 夥伴說明書：大家都能看，本人能寫
create policy r on public.manuals   for select to authenticated using (public.is_member());
create policy w on public.manuals   for all    to authenticated using (id = public.my_member_id() or public.is_admin()) with check (id = public.my_member_id() or public.is_admin());

-- 個人偏好（總覽要顯示哪些區塊）
create policy w on public.prefs     for all    to authenticated using (id = auth.uid()::text) with check (id = auth.uid()::text);

-- ---------- 即時同步 ----------
do $$
declare t text;
begin
  foreach t in array array['members','depts','projects','tasks','templates','goals','manuals','todos','daily','comments'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------- 頭貼 ----------
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict (id) do nothing;
drop policy if exists "avatars insert" on storage.objects;
drop policy if exists "avatars update" on storage.objects;
create policy "avatars insert" on storage.objects for insert to authenticated with check (bucket_id = 'avatars' and public.is_member());
create policy "avatars update" on storage.objects for update to authenticated using (bucket_id = 'avatars' and public.is_member());
