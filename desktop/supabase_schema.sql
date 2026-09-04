-- DBD Tracker community database. Apply with Supabase migrations.
-- Never ship a service-role key in the desktop application.
create extension if not exists pgcrypto;

create table if not exists public.community_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  consent_version text not null,
  community_opt_in boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.community_submissions (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  payload_hash text not null, match_count integer not null check (match_count between 1 and 100),
  payload jsonb not null, status text not null default 'accepted' check (status in ('accepted','rejected')),
  received_at timestamptz not null default now(), unique (owner_id, payload_hash)
);

create table if not exists public.community_matches (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  official_match_id text, match_hash text not null, played_at timestamptz not null,
  role text not null check (role in ('survivor','killer')), character_id text, map_id text, result text, kills_count integer, killer_id text,
  duration_sec integer check (duration_sec is null or duration_sec between 0 and 86400),
  score integer check (score is null or score between 0 and 1000000), patch_version text,
  platform text, region text, source text not null default 'official_stats', created_at timestamptz not null default now(),
  unique (owner_id, match_hash)
);
alter table public.community_matches add column if not exists kills_count integer;
create index if not exists community_matches_played_idx on public.community_matches (played_at desc);
create index if not exists community_matches_dimensions_idx on public.community_matches (patch_version, role, character_id, map_id);

create table if not exists public.community_match_loadouts (
  match_id uuid primary key references public.community_matches(id) on delete cascade,
  perks jsonb not null default '[]'::jsonb, item_id text, addons jsonb not null default '[]'::jsonb, offering_id text,
  killer_perks jsonb not null default '[]'::jsonb
);
alter table public.community_matches add column if not exists killer_id text;
alter table public.community_match_loadouts add column if not exists killer_perks jsonb not null default '[]'::jsonb;
create table if not exists public.community_match_participants (
  id uuid primary key default gen_random_uuid(), match_id uuid not null references public.community_matches(id) on delete cascade,
  character_id text, role text check (role in ('survivor','killer')), result text, perks jsonb not null default '[]'::jsonb,
  unique (match_id, character_id, role)
);

create table if not exists public.community_daily_stats (
  stat_date date not null, patch_version text not null default 'unknown', role text not null check (role in ('survivor','killer')),
  character_id text not null default '', map_id text not null default '', match_count integer not null default 0,
  escapes integer not null default 0, kills integer not null default 0, total_score bigint not null default 0,
  total_duration_sec bigint not null default 0, updated_at timestamptz not null default now(),
  primary key (stat_date, patch_version, role, character_id, map_id)
);
create table if not exists public.community_official_snapshots (
  id uuid primary key default gen_random_uuid(), section text not null, period text not null, role text not null,
  captured_at timestamptz not null, patch_version text, data jsonb not null, unique (section, period, role, captured_at)
);

-- Compatibilidade com a primeira versão, que criou estas relações como views.
-- Se já forem tabelas, elas são preservadas.
do $$
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'public_character_stats' and c.relkind = 'v'
  ) then execute 'drop view public.public_character_stats'; end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'public_map_stats' and c.relkind = 'v'
  ) then execute 'drop view public.public_map_stats'; end if;
end $$;
create table if not exists public.public_character_stats (
  patch_version text not null, role text not null, character_id text not null default '',
  match_count bigint not null, escapes bigint not null, kills bigint not null, average_score numeric,
  primary key (patch_version, role, character_id)
);
create table if not exists public.public_map_stats (
  patch_version text not null, role text not null, map_id text not null default '',
  match_count bigint not null, escapes bigint not null, kills bigint not null,
  primary key (patch_version, role, map_id)
);
create table if not exists public.public_killer_stats (
  patch_version text not null, killer_id text not null, match_count bigint not null, kills bigint not null,
  average_kills numeric, primary key (patch_version, killer_id)
);
create table if not exists public.public_perk_stats (
  patch_version text not null, role text not null, perk_id text not null, usage_count bigint not null,
  primary key (patch_version, role, perk_id)
);
create table if not exists public.public_build_stats (
  patch_version text not null, role text not null, build_id text not null, usage_count bigint not null,
  primary key (patch_version, role, build_id)
);
create table if not exists public.public_perk_pair_stats (
  patch_version text not null, role text not null, perk_a text not null, perk_b text not null,
  usage_count bigint not null, primary key (patch_version, role, perk_a, perk_b),
  check (perk_a < perk_b)
);
create table if not exists public.public_killer_map_stats (
  patch_version text not null, killer_id text not null, map_id text not null,
  match_count bigint not null, kills bigint not null, average_kills numeric,
  primary key (patch_version, killer_id, map_id)
);

create or replace function public.refresh_community_daily_stats()
returns void language sql security definer set search_path = public as $$
  delete from public.community_daily_stats;
  delete from public.public_character_stats;
  delete from public.public_map_stats;
  delete from public.public_killer_stats;
  delete from public.public_perk_stats;
  delete from public.public_build_stats;
  delete from public.public_perk_pair_stats;
  delete from public.public_killer_map_stats;
  insert into public.community_daily_stats
    (stat_date, patch_version, role, character_id, map_id, match_count, escapes, kills, total_score, total_duration_sec)
  select played_at::date, coalesce(patch_version, 'unknown'), role,
    coalesce(character_id, ''), coalesce(map_id, ''), count(*)::integer,
    sum(case when role = 'survivor' and lower(coalesce(result,'')) similar to '%(escape|escaped|fugiu|win)%' then 1 else 0 end)::integer,
    sum(case when role = 'killer' then coalesce(kills_count, 0) else 0 end)::integer,
    sum(coalesce(score, 0)), sum(coalesce(duration_sec, 0))
  from public.community_matches
  group by played_at::date, coalesce(patch_version, 'unknown'), role, coalesce(character_id, ''), coalesce(map_id, '');
  insert into public.public_character_stats (patch_version, role, character_id, match_count, escapes, kills, average_score)
  select patch_version, role, coalesce(nullif(character_id,''),''), sum(match_count), sum(escapes), sum(kills),
    round(sum(total_score)::numeric / nullif(sum(match_count),0))
  from public.community_daily_stats group by patch_version, role, character_id having sum(match_count) >= 20;
  insert into public.public_map_stats (patch_version, role, map_id, match_count, escapes, kills)
  select patch_version, role, coalesce(nullif(map_id,''),''), sum(match_count), sum(escapes), sum(kills)
  from public.community_daily_stats group by patch_version, role, map_id having sum(match_count) >= 20;
  insert into public.public_killer_stats (patch_version, killer_id, match_count, kills, average_kills)
  select coalesce(patch_version, 'unknown'), killer_id, count(*), sum(coalesce(kills_count, 0)),
    round(sum(coalesce(kills_count, 0))::numeric / nullif(count(*), 0), 2)
  from public.community_matches where killer_id is not null and killer_id <> ''
  group by coalesce(patch_version, 'unknown'), killer_id having count(*) >= 20;
  insert into public.public_perk_stats (patch_version, role, perk_id, usage_count)
  select coalesce(m.patch_version, 'unknown'), m.role, perk_id, count(*)
  from public.community_matches m join public.community_match_loadouts l on l.match_id = m.id
  cross join lateral jsonb_array_elements_text(l.perks) as perk_id
  group by coalesce(m.patch_version, 'unknown'), m.role, perk_id having count(*) >= 20;
  insert into public.public_perk_stats (patch_version, role, perk_id, usage_count)
  select coalesce(m.patch_version, 'unknown'), 'killer', perk_id, count(*)
  from public.community_matches m join public.community_match_loadouts l on l.match_id = m.id
  cross join lateral jsonb_array_elements_text(l.killer_perks) as perk_id
  where jsonb_array_length(l.killer_perks) > 0
  group by coalesce(m.patch_version, 'unknown'), perk_id having count(*) >= 20;
  insert into public.public_build_stats (patch_version, role, build_id, usage_count)
  select coalesce(m.patch_version, 'unknown'), m.role,
    array_to_string(array(select jsonb_array_elements_text(l.perks) order by 1), ' + '), count(*)
  from public.community_matches m join public.community_match_loadouts l on l.match_id = m.id
  where jsonb_array_length(l.perks) = 4
  group by coalesce(m.patch_version, 'unknown'), m.role, l.perks having count(*) >= 20;
  insert into public.public_perk_pair_stats (patch_version, role, perk_a, perk_b, usage_count)
  select coalesce(m.patch_version, 'unknown'), m.role, least(a.perk, b.perk), greatest(a.perk, b.perk), count(*)
  from public.community_matches m join public.community_match_loadouts l on l.match_id = m.id
  cross join lateral jsonb_array_elements_text(l.perks) a(perk)
  cross join lateral jsonb_array_elements_text(l.perks) b(perk)
  where a.perk < b.perk
  group by coalesce(m.patch_version, 'unknown'), m.role, least(a.perk, b.perk), greatest(a.perk, b.perk) having count(*) >= 20;
  insert into public.public_killer_map_stats (patch_version, killer_id, map_id, match_count, kills, average_kills)
  select coalesce(m.patch_version, 'unknown'), m.killer_id, m.map_id, count(*), sum(coalesce(m.kills_count, 0)),
    round(sum(coalesce(m.kills_count, 0))::numeric / nullif(count(*), 0), 2)
  from public.community_matches m
  where m.killer_id is not null and m.killer_id <> '' and m.map_id is not null and m.map_id <> ''
  group by coalesce(m.patch_version, 'unknown'), m.killer_id, m.map_id having count(*) >= 20;
$$;
revoke all on function public.refresh_community_daily_stats() from public, anon, authenticated;
grant execute on function public.refresh_community_daily_stats() to service_role;

alter table public.community_profiles enable row level security;
alter table public.community_submissions enable row level security;
alter table public.community_matches enable row level security;
alter table public.community_match_loadouts enable row level security;
alter table public.community_match_participants enable row level security;
alter table public.community_daily_stats enable row level security;
alter table public.community_official_snapshots enable row level security;

drop policy if exists community_profiles_owner on public.community_profiles;
drop policy if exists community_submissions_owner on public.community_submissions;
drop policy if exists community_matches_owner on public.community_matches;
drop policy if exists community_loadouts_owner on public.community_match_loadouts;
drop policy if exists community_participants_owner on public.community_match_participants;
revoke all on public.community_profiles, public.community_submissions, public.community_matches,
  public.community_match_loadouts, public.community_match_participants, public.community_daily_stats,
  public.community_official_snapshots from anon, authenticated;

alter table public.public_character_stats enable row level security;
alter table public.public_map_stats enable row level security;
alter table public.public_killer_stats enable row level security;
alter table public.public_perk_stats enable row level security;
alter table public.public_build_stats enable row level security;
alter table public.public_perk_pair_stats enable row level security;
alter table public.public_killer_map_stats enable row level security;
drop policy if exists public_character_stats_read on public.public_character_stats;
create policy public_character_stats_read on public.public_character_stats for select to anon, authenticated using (true);
drop policy if exists public_map_stats_read on public.public_map_stats;
create policy public_map_stats_read on public.public_map_stats for select to anon, authenticated using (true);
grant select on public.public_character_stats, public.public_map_stats to anon, authenticated;
drop policy if exists public_killer_stats_read on public.public_killer_stats;
create policy public_killer_stats_read on public.public_killer_stats for select to anon, authenticated using (true);
drop policy if exists public_perk_stats_read on public.public_perk_stats;
create policy public_perk_stats_read on public.public_perk_stats for select to anon, authenticated using (true);
drop policy if exists public_build_stats_read on public.public_build_stats;
create policy public_build_stats_read on public.public_build_stats for select to anon, authenticated using (true);
drop policy if exists public_perk_pair_stats_read on public.public_perk_pair_stats;
create policy public_perk_pair_stats_read on public.public_perk_pair_stats for select to anon, authenticated using (true);
drop policy if exists public_killer_map_stats_read on public.public_killer_map_stats;
create policy public_killer_map_stats_read on public.public_killer_map_stats for select to anon, authenticated using (true);
grant select on public.public_killer_stats, public.public_perk_stats, public.public_build_stats,
  public.public_perk_pair_stats, public.public_killer_map_stats to anon, authenticated;
grant all on public.public_character_stats, public.public_map_stats, public.public_killer_stats,
  public.public_perk_stats, public.public_build_stats, public.public_perk_pair_stats,
  public.public_killer_map_stats to service_role;
