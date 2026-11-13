-- 職掘工作台 · 公用信箱未讀提醒（2026-11）
-- 在 schema.sql、meetings.sql 之後執行。可以重複執行。
-- 只存「未讀、近 7 天」信件的寄件人、主旨、摘要（Gmail 提供的前一兩行），讀過或過期就刪掉；不存信件內文。

-- 信箱：id = 信箱地址
-- data: {email, label, allow:[member id], private:bool, owner, status, error, unread, checkedAt, connectedAt}
create table if not exists public.mailboxes (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.mailboxes enable row level security;
revoke all on public.mailboxes from anon;
grant select, update on public.mailboxes to authenticated;
grant select, insert, update, delete on public.mailboxes to service_role;

-- 誰看得到：個人信箱只有擁有者；公用信箱是管理員＋被勾選的夥伴
create or replace function public.can_see_mailbox(mb text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member() and exists (
    select 1 from public.mailboxes m where m.id = mb and (
      case when coalesce((m.data->>'private')::boolean, false)
        then m.data->>'owner' = public.my_member_id()
        else public.is_admin() or coalesce(m.data->'allow', '[]'::jsonb) ? public.my_member_id()
      end))
$$;
revoke execute on function public.can_see_mailbox(text) from public, anon;
grant execute on function public.can_see_mailbox(text) to authenticated, service_role;

drop policy if exists r on public.mailboxes;
drop policy if exists u on public.mailboxes;
create policy r on public.mailboxes for select to authenticated using (public.can_see_mailbox(id));
-- 只有管理員能改名稱、權限；個人信箱只有擁有者能改
create policy u on public.mailboxes for update to authenticated
  using (public.is_admin() and (not coalesce((data->>'private')::boolean, false) or data->>'owner' = public.my_member_id()))
  with check (public.is_admin() and (not coalesce((data->>'private')::boolean, false) or data->>'owner' = public.my_member_id()));

-- 未讀信件（只由後端寫入）
create table if not exists public.mail_msgs (
  mailbox text not null references public.mailboxes(id) on delete cascade,
  id text not null,
  thread text,
  from_name text,
  from_addr text,
  subject text,
  snippet text,
  at timestamptz,
  notified boolean not null default false,
  primary key (mailbox, id)
);
create index if not exists mail_msgs_at on public.mail_msgs (at desc);
alter table public.mail_msgs enable row level security;
revoke all on public.mail_msgs from anon;
grant select on public.mail_msgs to authenticated;
grant select, insert, update, delete on public.mail_msgs to service_role;
drop policy if exists r on public.mail_msgs;
create policy r on public.mail_msgs for select to authenticated using (public.can_see_mailbox(mailbox));

-- 每個人自己的靜音（不提醒、不發 Slack 私訊）
create table if not exists public.mail_mutes (
  mid text not null,
  mailbox text not null references public.mailboxes(id) on delete cascade,
  primary key (mid, mailbox)
);
alter table public.mail_mutes enable row level security;
revoke all on public.mail_mutes from anon;
grant select, insert, delete on public.mail_mutes to authenticated;
grant select, insert, update, delete on public.mail_mutes to service_role;
drop policy if exists own on public.mail_mutes;
create policy own on public.mail_mutes for all to authenticated
  using (mid = public.my_member_id()) with check (mid = public.my_member_id());

do $$ begin
  begin alter publication supabase_realtime add table public.mailboxes; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.mail_msgs; exception when duplicate_object then null; end;
end $$;

create or replace function public.doc_patch(tbl text, doc_id text, patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  if tbl not in ('members','depts','projects','tasks','templates','goals','manuals','todos','daily','comments','prefs','gifts','leaves','meetings','mailboxes') then
    raise exception 'unknown table %', tbl;
  end if;
  execute format('update public.%I set data = data || $1, updated_at = now() where id = $2', tbl) using patch, doc_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'not_found_or_denied' using errcode = '42501'; end if;
end $$;
grant execute on function public.doc_patch(text, text, jsonb) to authenticated, service_role;

-- 信箱授權（refresh token 先在函式裡加密才存進來；只有後端能讀寫）
create table if not exists private.mailtokens (
  mailbox text primary key,
  enc text not null,
  scope text,
  updated_at timestamptz not null default now()
);
revoke all on private.mailtokens from public, anon, authenticated;
create or replace function public.mailtoken_get(p_mb text) returns jsonb
language sql stable security definer set search_path = private, public as $$
  select to_jsonb(t) from private.mailtokens t where t.mailbox = p_mb
$$;
create or replace function public.mailtoken_put(p_mb text, p_enc text, p_scope text) returns void
language sql security definer set search_path = private, public as $$
  insert into private.mailtokens (mailbox, enc, scope, updated_at) values (p_mb, p_enc, p_scope, now())
  on conflict (mailbox) do update set enc = excluded.enc, scope = excluded.scope, updated_at = now()
$$;
create or replace function public.mailtoken_del(p_mb text) returns void
language sql security definer set search_path = private, public as $$
  delete from private.mailtokens where mailbox = p_mb
$$;
revoke execute on function public.mailtoken_get(text) from public, anon, authenticated;
revoke execute on function public.mailtoken_put(text, text, text) from public, anon, authenticated;
revoke execute on function public.mailtoken_del(text) from public, anon, authenticated;
grant execute on function public.mailtoken_get(text) to service_role;
grant execute on function public.mailtoken_put(text, text, text) to service_role;
grant execute on function public.mailtoken_del(text) to service_role;

-- 每 5 分鐘檢查一次新信（台北 22:00–08:00 不發 Slack 私訊，早上一起補）
do $$ begin
  perform cron.unschedule('mail-poll');
exception when others then null; end $$;
select cron.schedule('mail-poll', '*/5 * * * *', $c$
  select net.http_post(
    url := 'https://pratgdxlgwgjchkvnaum.supabase.co/functions/v1/mail',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select v from private.app_secrets where k='cron')),
    body := '{"mode":"poll"}'::jsonb,
    timeout_milliseconds := 60000)
$c$);
