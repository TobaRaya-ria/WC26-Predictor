create extension if not exists "pgcrypto";

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text,
  email text unique,
  avatar_url text,
  role text default 'user',
  created_at timestamptz default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  insert into public.profiles (id, username, display_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    case
      when lower(new.email) like '%@worldcup-predictor.invalid' then null
      else new.email
    end,
    coalesce(new.raw_user_meta_data->>'avatar_url', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

alter function public.handle_new_user() owner to postgres;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create table if not exists fixtures (
  id uuid primary key default gen_random_uuid(),
  fifa_match_id text unique,
  round text not null,
  group_code text,
  home_team text not null,
  away_team text not null,
  kickoff_at timestamptz not null,
  venue text,
  status text default 'scheduled',
  home_score int,
  away_score int,
  winner_team text,
  updated_at timestamptz default now()
);

create table if not exists tournament_predictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  group_rankings jsonb not null,
  third_place_qualifiers jsonb not null,
  knockout_picks jsonb not null,
  final_placements jsonb,
  locked_at timestamptz,
  submitted_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id)
);

create table if not exists actual_tournament_results (
  team_code text primary key,
  team_name text not null,
  placement text,
  updated_at timestamptz default now(),
  check (
    placement is null
    or placement = ''
    or placement in ('winner', 'runner', 'third', 'fourth', 'qf', 'r16', 'r32', 'grouped')
  )
);

create table if not exists match_predictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  fixture_id uuid not null references fixtures(id) on delete cascade,
  predicted_home_score int,
  predicted_away_score int,
  predicted_outcome text not null,
  locked_at timestamptz,
  submitted_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, fixture_id)
);

alter table match_predictions alter column predicted_home_score drop not null;
alter table match_predictions alter column predicted_away_score drop not null;

create table if not exists scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  bracket_score numeric default 0,
  match_score numeric default 0,
  total_score numeric default 0,
  exact_scores_count int default 0,
  correct_results_count int default 0,
  updated_at timestamptz default now(),
  unique(user_id)
);

create or replace view leaderboard
with (security_invoker = false)
as
with result_state as (
  select count(*) as finished_matches
  from fixtures
  where home_score is not null
    and away_score is not null
),
predictors as (
  select user_id from match_predictions
  union
  select user_id from tournament_predictions
),
match_scores as (
  select
    mp.user_id,
    sum(
      case
        when f.home_score is null or f.away_score is null then 0
        when mp.predicted_outcome =
          case
            when f.home_score = f.away_score then 'draw'
            when f.home_score > f.away_score then 'home'
            else 'away'
          end
        then
          case f.round
            when 'group_1' then 1
            when 'group_2' then 1.2
            when 'group_3' then 1.3
            when 'round_32' then 1.5
            when 'round_16' then 2.5
            when 'quarter_final' then 5
            when 'semi_final' then 7
            when 'third_place' then 8
            when 'final' then 12
            else 0
          end
          *
          case
            when mp.predicted_home_score = f.home_score
             and mp.predicted_away_score = f.away_score
            then 2
            else 1
          end
        else 0
      end
    )::numeric as match_score
  from match_predictions mp
  join fixtures f on f.id = mp.fixture_id
  group by mp.user_id
),
prediction_placements as (
  select
    tp.user_id,
    placement.key as predicted_placement,
    team.value->>'code' as team_code
  from tournament_predictions tp
  cross join lateral jsonb_each(coalesce(tp.final_placements, '{}'::jsonb)) as placement(key, value)
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(placement.value) = 'array' then placement.value
      else '[]'::jsonb
    end
  ) as team(value)
  where team.value ? 'code'
),
actual_placements as (
  select team_code, placement
  from actual_tournament_results
  where placement is not null
    and placement <> ''
),
bracket_base_scores as (
  select
    pp.user_id,
    sum(
      case
        when ap.placement = 'winner' and pp.predicted_placement = 'winner' then 30
        when ap.placement = 'winner' and pp.predicted_placement in ('winner', 'runner') then 16
        when ap.placement = 'runner' and pp.predicted_placement = 'runner' then 20
        when ap.placement = 'runner' and pp.predicted_placement in ('winner', 'runner') then 16
        when ap.placement in ('third', 'fourth') and pp.predicted_placement = ap.placement then 13
        when ap.placement in ('third', 'fourth') and pp.predicted_placement in ('third', 'fourth') then 10
        when ap.placement = 'qf' and pp.predicted_placement = 'qf' then 7
        when ap.placement = 'r16' and pp.predicted_placement = 'r16' then 4
        when ap.placement = 'r32' and pp.predicted_placement = 'r32' then 3
        when ap.placement = 'grouped' and pp.predicted_placement = 'grouped' then 2
        else 0
      end
    )::numeric as base_score
  from prediction_placements pp
  join actual_placements ap on ap.team_code = pp.team_code
  group by pp.user_id
),
bracket_category_bonus as (
  select
    per_category.user_id,
    sum(
      case
        when per_category.actual_count > 0
         and per_category.correct_count::numeric / per_category.actual_count >= 0.75 then 10
        when per_category.actual_count > 0
         and per_category.correct_count::numeric / per_category.actual_count >= 0.5 then 4
        else 0
      end
    )::numeric as category_bonus
  from (
    select
      tp.user_id,
      ap.placement,
      count(ap.team_code) as actual_count,
      count(pp.team_code) filter (where pp.predicted_placement = ap.placement) as correct_count
    from tournament_predictions tp
    cross join actual_placements ap
    left join prediction_placements pp
      on pp.user_id = tp.user_id
     and pp.team_code = ap.team_code
    where ap.placement in ('grouped', 'r32', 'r16')
    group by tp.user_id, ap.placement
  ) per_category
  group by per_category.user_id
),
bracket_top_bonus as (
  select
    tp.user_id,
    case
      when count(*) filter (
        where ap.placement in ('winner', 'runner', 'third', 'fourth')
          and pp.predicted_placement = ap.placement
      ) = 4
      and count(*) filter (where ap.placement in ('winner', 'runner', 'third', 'fourth')) = 4
      then 15::numeric
      else 0::numeric
    end as top_bonus
  from tournament_predictions tp
  cross join actual_placements ap
  left join prediction_placements pp
    on pp.user_id = tp.user_id
   and pp.team_code = ap.team_code
  group by tp.user_id
),
bracket_scores as (
  select
    tp.user_id,
    (
      coalesce(bbs.base_score, 0)
      + coalesce(bcb.category_bonus, 0)
      + coalesce(btb.top_bonus, 0)
    )::numeric as bracket_score
  from tournament_predictions tp
  left join bracket_base_scores bbs on bbs.user_id = tp.user_id
  left join bracket_category_bonus bcb on bcb.user_id = tp.user_id
  left join bracket_top_bonus btb on btb.user_id = tp.user_id
),
scored as (
  select
    p.id as user_id,
    p.username,
    coalesce(bs.bracket_score, 0)::numeric as bracket_score,
    coalesce(ms.match_score, 0)::numeric as match_score,
    (coalesce(bs.bracket_score, 0) + coalesce(ms.match_score, 0))::numeric as total_score
  from profiles p
  join predictors pr on pr.user_id = p.id
  left join match_scores ms on ms.user_id = p.id
  left join bracket_scores bs on bs.user_id = p.id
  cross join result_state rs
  where rs.finished_matches > 0
     or exists (select 1 from actual_placements)
)
select
  user_id,
  username,
  total_score,
  bracket_score,
  match_score,
  rank() over (order by total_score desc, username asc) as rank
from scored;

grant usage on schema public to anon, authenticated;
grant select on profiles, fixtures, actual_tournament_results, scores to anon, authenticated;
grant select on leaderboard to anon, authenticated;
grant insert, update on profiles to authenticated;
grant select, insert, update on tournament_predictions to authenticated;
grant select, insert, update on match_predictions to authenticated;

alter table profiles enable row level security;
alter table fixtures enable row level security;
alter table tournament_predictions enable row level security;
alter table actual_tournament_results enable row level security;
alter table match_predictions enable row level security;
alter table scores enable row level security;

drop policy if exists "Public profiles are readable" on profiles;
create policy "Public profiles are readable"
on profiles for select
using (true);

drop policy if exists "Users can insert their own profile" on profiles;
create policy "Users can insert their own profile"
on profiles for insert
with check (auth.uid() = id);

drop policy if exists "Users can update their own profile" on profiles;
create policy "Users can update their own profile"
on profiles for update
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "Fixtures are readable" on fixtures;
create policy "Fixtures are readable"
on fixtures for select
using (true);

drop policy if exists "Actual tournament results are readable" on actual_tournament_results;
create policy "Actual tournament results are readable"
on actual_tournament_results for select
using (true);

drop policy if exists "Users can read their tournament prediction" on tournament_predictions;
create policy "Users can read their tournament prediction"
on tournament_predictions for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert their tournament prediction" on tournament_predictions;
create policy "Users can insert their tournament prediction"
on tournament_predictions for insert
with check (
  auth.uid() = user_id
  and now() < timestamptz '2026-06-28 23:59:59+00'
);

drop policy if exists "Users can update their tournament prediction" on tournament_predictions;
create policy "Users can update their tournament prediction"
on tournament_predictions for update
using (
  auth.uid() = user_id
  and now() < timestamptz '2026-06-28 23:59:59+00'
)
with check (
  auth.uid() = user_id
  and now() < timestamptz '2026-06-28 23:59:59+00'
);

drop policy if exists "Users can read their match predictions" on match_predictions;
create policy "Users can read their match predictions"
on match_predictions for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert their match predictions" on match_predictions;
create policy "Users can insert their match predictions"
on match_predictions for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from fixtures f
    where f.id = fixture_id
      and f.kickoff_at > now()
  )
);

drop policy if exists "Users can update their match predictions" on match_predictions;
create policy "Users can update their match predictions"
on match_predictions for update
using (auth.uid() = user_id)
with check (
  auth.uid() = user_id
  and exists (
    select 1
    from fixtures f
    where f.id = fixture_id
      and f.kickoff_at > now()
  )
);

drop policy if exists "Scores are readable" on scores;
create policy "Scores are readable"
on scores for select
using (true);

drop policy if exists "Users can create their score row" on scores;

drop policy if exists "Users can update their score row" on scores;
