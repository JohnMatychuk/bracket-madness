-- ============================================================
-- Milan Bracket Madness — Initial Schema
-- Paste this entire file into Supabase SQL Editor and click Run.
-- ============================================================

create extension if not exists pg_cron;

-- ============================================================
-- TABLES
-- ============================================================

create table public.players (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.admins (
  player_id uuid primary key references public.players(id) on delete cascade
);

create table public.brackets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  status text not null default 'setup'
    check (status in ('setup', 'champion_picks', 'voting', 'complete')),
  champion_picks_close_at timestamptz,
  champion_bonus_points int not null default 5,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  bracket_id uuid not null references public.brackets(id) on delete cascade,
  seed int not null,
  name text not null,
  unique (bracket_id, seed)
);

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  bracket_id uuid not null references public.brackets(id) on delete cascade,
  round_number int not null check (round_number between 1 and 5),
  name text not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'open', 'closed')),
  unique (bracket_id, round_number)
);

create table public.matchups (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  position int not null,
  entry_a_id uuid references public.entries(id),
  entry_b_id uuid references public.entries(id),
  winner_entry_id uuid references public.entries(id),
  is_tie boolean not null default false,
  resolved_at timestamptz,
  unique (round_id, position)
);

create table public.votes (
  id uuid primary key default gen_random_uuid(),
  matchup_id uuid not null references public.matchups(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  voted_entry_id uuid not null references public.entries(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (matchup_id, player_id)
);

create table public.champion_picks (
  id uuid primary key default gen_random_uuid(),
  bracket_id uuid not null references public.brackets(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  entry_id uuid not null references public.entries(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bracket_id, player_id)
);

-- ============================================================
-- INDEXES
-- ============================================================
create index idx_entries_bracket on public.entries(bracket_id);
create index idx_rounds_bracket on public.rounds(bracket_id);
create index idx_matchups_round on public.matchups(round_id);
create index idx_votes_matchup on public.votes(matchup_id);
create index idx_votes_player on public.votes(player_id);
create index idx_champion_picks_bracket on public.champion_picks(bracket_id);
create index idx_champion_picks_player on public.champion_picks(player_id);

-- ============================================================
-- AUTO-CREATE PLAYER ON SIGNUP (with @milanlaser.com gate)
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(new.email) not like '%@milanlaser.com' then
    raise exception 'Only @milanlaser.com emails are allowed'
      using errcode = '22023';
  end if;
  insert into public.players (id, email, display_name)
  values (
    new.id,
    new.email,
    initcap(replace(split_part(new.email, '@', 1), '.', ' '))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- ROUND COMPLETION CHECK (used by auto-close trigger)
-- ============================================================
create or replace function public.round_is_complete(p_round_id uuid)
returns boolean
language sql
stable
as $$
  select not exists (
    select 1
    from public.players p
    cross join public.matchups m
    where m.round_id = p_round_id
      and not exists (
        select 1 from public.votes v
        where v.matchup_id = m.id and v.player_id = p.id
      )
  );
$$;

-- ============================================================
-- ADVANCE WINNERS TO NEXT ROUND
-- ============================================================
create or replace function public.advance_winners(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bracket_id uuid;
  v_round_num int;
  v_next_round_id uuid;
  pair record;
  has_unresolved boolean;
begin
  select exists (
    select 1 from public.matchups
    where round_id = p_round_id
      and (winner_entry_id is null or is_tie)
  ) into has_unresolved;

  if has_unresolved then return; end if;

  select bracket_id, round_number into v_bracket_id, v_round_num
  from public.rounds where id = p_round_id;

  select id into v_next_round_id
  from public.rounds
  where bracket_id = v_bracket_id and round_number = v_round_num + 1;

  if v_next_round_id is null then
    update public.brackets set status = 'complete' where id = v_bracket_id;
    return;
  end if;

  for pair in
    select
      m1.position as p1,
      m1.winner_entry_id as w1,
      m2.winner_entry_id as w2
    from public.matchups m1
    join public.matchups m2
      on m2.round_id = m1.round_id and m2.position = m1.position + 1
    where m1.round_id = p_round_id and m1.position % 2 = 0
  loop
    update public.matchups
      set entry_a_id = pair.w1, entry_b_id = pair.w2
      where round_id = v_next_round_id and position = pair.p1 / 2;
  end loop;
end;
$$;

-- ============================================================
-- CLOSE A ROUND (compute winners, advance, flag ties)
-- ============================================================
create or replace function public.close_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m_rec record;
  v_votes_a int;
  v_votes_b int;
begin
  update public.rounds set status = 'closed' where id = p_round_id;

  for m_rec in
    select * from public.matchups
    where round_id = p_round_id
      and winner_entry_id is null
      and not is_tie
  loop
    select
      count(*) filter (where voted_entry_id = m_rec.entry_a_id),
      count(*) filter (where voted_entry_id = m_rec.entry_b_id)
    into v_votes_a, v_votes_b
    from public.votes
    where matchup_id = m_rec.id;

    if v_votes_a > v_votes_b then
      update public.matchups
        set winner_entry_id = m_rec.entry_a_id, resolved_at = now()
        where id = m_rec.id;
    elsif v_votes_b > v_votes_a then
      update public.matchups
        set winner_entry_id = m_rec.entry_b_id, resolved_at = now()
        where id = m_rec.id;
    else
      update public.matchups set is_tie = true where id = m_rec.id;
    end if;
  end loop;

  perform public.advance_winners(p_round_id);
end;
$$;

-- ============================================================
-- ADMIN: RESOLVE TIE
-- ============================================================
create or replace function public.resolve_tie(
  p_matchup_id uuid,
  p_winner_entry_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
begin
  if not exists (select 1 from public.admins where player_id = auth.uid()) then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  update public.matchups
    set winner_entry_id = p_winner_entry_id,
        is_tie = false,
        resolved_at = now()
    where id = p_matchup_id;

  select round_id into v_round_id from public.matchups where id = p_matchup_id;
  perform public.advance_winners(v_round_id);
end;
$$;

-- ============================================================
-- ADMIN: FORCE-CLOSE A ROUND BEFORE DEADLINE
-- ============================================================
create or replace function public.admin_close_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admins where player_id = auth.uid()) then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  perform public.close_round(p_round_id);
end;
$$;

-- ============================================================
-- ADMIN: OPEN CHAMPION PICKS
-- ============================================================
create or replace function public.admin_open_champion_picks(
  p_bracket_id uuid,
  p_close_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admins where player_id = auth.uid()) then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  update public.brackets
    set champion_picks_close_at = p_close_at,
        status = case when status = 'setup' then 'champion_picks' else status end
    where id = p_bracket_id;
end;
$$;

-- ============================================================
-- AUTO-CLOSE EARLY WHEN ALL PLAYERS HAVE VOTED
-- ============================================================
create or replace function public.maybe_close_round_early()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_status text;
begin
  select round_id into v_round_id from public.matchups where id = new.matchup_id;
  select status into v_status from public.rounds where id = v_round_id;
  if v_status = 'open' and public.round_is_complete(v_round_id) then
    perform public.close_round(v_round_id);
  end if;
  return new;
end;
$$;

create trigger after_vote_insert
  after insert or update on public.votes
  for each row execute function public.maybe_close_round_early();

-- ============================================================
-- VIEWS
-- ============================================================

create or replace view public.matchup_tallies
with (security_invoker = true) as
select
  m.id as matchup_id,
  m.round_id,
  m.entry_a_id,
  m.entry_b_id,
  count(*) filter (where v.voted_entry_id = m.entry_a_id) as votes_a,
  count(*) filter (where v.voted_entry_id = m.entry_b_id) as votes_b,
  count(*) as total_votes
from public.matchups m
left join public.votes v on v.matchup_id = m.id
group by m.id, m.round_id, m.entry_a_id, m.entry_b_id;

create or replace view public.leaderboard
with (security_invoker = true) as
with vote_points as (
  select v.player_id, count(*) as round_points
  from public.votes v
  join public.matchups m on m.id = v.matchup_id
  where m.winner_entry_id = v.voted_entry_id
  group by v.player_id
),
champion_alive_status as (
  select
    cp.player_id,
    cp.bracket_id,
    cp.entry_id,
    not exists (
      select 1 from public.matchups m
      join public.rounds r on r.id = m.round_id
      where r.bracket_id = cp.bracket_id
        and m.winner_entry_id is not null
        and (m.entry_a_id = cp.entry_id or m.entry_b_id = cp.entry_id)
        and m.winner_entry_id != cp.entry_id
    ) as is_alive
  from public.champion_picks cp
),
champion_bonus as (
  select cp.player_id, sum(b.champion_bonus_points) as bonus
  from public.champion_picks cp
  join public.brackets b on b.id = cp.bracket_id
  join public.rounds r on r.bracket_id = b.id and r.round_number = 5
  join public.matchups m on m.round_id = r.id
  where b.status = 'complete' and m.winner_entry_id = cp.entry_id
  group by cp.player_id
)
select
  p.id as player_id,
  p.display_name,
  coalesce(vp.round_points, 0) + coalesce(cb.bonus, 0) as total_points,
  coalesce(vp.round_points, 0) as round_points,
  coalesce(cb.bonus, 0) as champion_bonus,
  (select count(*) from champion_alive_status cas
     where cas.player_id = p.id and cas.is_alive) as champions_alive,
  (select count(*) from public.champion_picks where player_id = p.id) as champions_picked
from public.players p
left join vote_points vp on vp.player_id = p.id
left join champion_bonus cb on cb.player_id = p.id;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.players enable row level security;
alter table public.brackets enable row level security;
alter table public.entries enable row level security;
alter table public.rounds enable row level security;
alter table public.matchups enable row level security;
alter table public.votes enable row level security;
alter table public.champion_picks enable row level security;
alter table public.admins enable row level security;

create policy "Players visible to authenticated"
  on public.players for select to authenticated using (true);

create policy "Players update own row"
  on public.players for update to authenticated using (auth.uid() = id);

create policy "Brackets readable"
  on public.brackets for select to authenticated using (true);

create policy "Brackets admin write"
  on public.brackets for all to authenticated
  using (exists (select 1 from public.admins where player_id = auth.uid()))
  with check (exists (select 1 from public.admins where player_id = auth.uid()));

create policy "Entries readable"
  on public.entries for select to authenticated using (true);

create policy "Entries admin write"
  on public.entries for all to authenticated
  using (exists (select 1 from public.admins where player_id = auth.uid()))
  with check (exists (select 1 from public.admins where player_id = auth.uid()));

create policy "Rounds readable"
  on public.rounds for select to authenticated using (true);

create policy "Rounds admin write"
  on public.rounds for all to authenticated
  using (exists (select 1 from public.admins where player_id = auth.uid()))
  with check (exists (select 1 from public.admins where player_id = auth.uid()));

create policy "Matchups readable"
  on public.matchups for select to authenticated using (true);

create policy "Matchups admin write"
  on public.matchups for all to authenticated
  using (exists (select 1 from public.admins where player_id = auth.uid()))
  with check (exists (select 1 from public.admins where player_id = auth.uid()));

create policy "Own votes readable"
  on public.votes for select to authenticated
  using (player_id = auth.uid());

create policy "All votes readable in closed rounds"
  on public.votes for select to authenticated
  using (
    exists (
      select 1 from public.matchups m
      join public.rounds r on r.id = m.round_id
      where m.id = votes.matchup_id and r.status = 'closed'
    )
  );

create policy "Cast vote in open round"
  on public.votes for insert to authenticated
  with check (
    player_id = auth.uid()
    and exists (
      select 1 from public.matchups m
      join public.rounds r on r.id = m.round_id
      where m.id = votes.matchup_id
        and r.status = 'open'
        and now() < r.closes_at
    )
  );

create policy "Update vote in open round"
  on public.votes for update to authenticated
  using (
    player_id = auth.uid()
    and exists (
      select 1 from public.matchups m
      join public.rounds r on r.id = m.round_id
      where m.id = votes.matchup_id
        and r.status = 'open'
        and now() < r.closes_at
    )
  );

create policy "Own picks readable"
  on public.champion_picks for select to authenticated
  using (player_id = auth.uid());

create policy "All picks readable when bracket complete"
  on public.champion_picks for select to authenticated
  using (
    exists (
      select 1 from public.brackets b
      where b.id = champion_picks.bracket_id and b.status = 'complete'
    )
  );

create policy "Cast champion pick"
  on public.champion_picks for insert to authenticated
  with check (
    player_id = auth.uid()
    and exists (
      select 1 from public.brackets b
      where b.id = champion_picks.bracket_id
        and b.status in ('champion_picks', 'voting')
        and (b.champion_picks_close_at is null or now() < b.champion_picks_close_at)
    )
  );

create policy "Update champion pick before lock"
  on public.champion_picks for update to authenticated
  using (
    player_id = auth.uid()
    and exists (
      select 1 from public.brackets b
      where b.id = champion_picks.bracket_id
        and b.status in ('champion_picks', 'voting')
        and (b.champion_picks_close_at is null or now() < b.champion_picks_close_at)
    )
  );

create policy "Admins see admins"
  on public.admins for select to authenticated
  using (exists (select 1 from public.admins a where a.player_id = auth.uid()));

-- ============================================================
-- SCHEDULED ROUND-STATE TICK (every 5 minutes)
-- ============================================================
select cron.schedule(
  'round-state-tick',
  '*/5 * * * *',
  $$
  do $body$
  declare r record;
  begin
    update public.rounds
      set status = 'open'
      where status = 'pending' and opens_at <= now();

    update public.brackets b
      set status = 'voting'
      from public.rounds r
      where r.bracket_id = b.id
        and r.round_number = 1
        and r.status = 'open'
        and b.status in ('champion_picks', 'setup');

    for r in
      select id from public.rounds
      where status = 'open' and closes_at <= now()
    loop
      perform public.close_round(r.id);
    end loop;
  end $body$;
  $$
);

-- ============================================================
-- DONE. Next steps:
-- 1. Supabase dashboard → Auth → Providers → Email → turn OFF "Confirm email".
-- 2. Sign up your own account at the deployed site.
-- 3. Run this in SQL Editor to make yourself admin:
--      insert into public.admins (player_id)
--      select id from public.players where email = 'YOUR_EMAIL@milanlaser.com';
-- 4. Open /admin.html and start setting things up.
-- ============================================================
