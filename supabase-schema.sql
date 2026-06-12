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

create table if not exists match_predictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  fixture_id uuid not null references fixtures(id) on delete cascade,
  predicted_home_score int not null,
  predicted_away_score int not null,
  predicted_outcome text not null,
  locked_at timestamptz,
  submitted_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, fixture_id)
);

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
scored as (
  select
    p.id as user_id,
    p.username,
    0::numeric as bracket_score,
    coalesce(ms.match_score, 0)::numeric as match_score,
    coalesce(ms.match_score, 0)::numeric as total_score
  from profiles p
  join predictors pr on pr.user_id = p.id
  left join match_scores ms on ms.user_id = p.id
  cross join result_state rs
  where rs.finished_matches > 0
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
grant select on profiles, fixtures, scores to anon, authenticated;
grant select on leaderboard to anon, authenticated;
grant insert, update on profiles to authenticated;
grant select, insert, update on tournament_predictions to authenticated;
grant select, insert, update on match_predictions to authenticated;

alter table profiles enable row level security;
alter table fixtures enable row level security;
alter table tournament_predictions enable row level security;
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
