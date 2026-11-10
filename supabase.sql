-- VideoTk: pega esto en Supabase → SQL Editor → New query → Run.
-- Crea la tabla de videos y hace que cada usuario solo pueda ver y tocar los suyos.

create table if not exists public.videos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  url         text not null check (url ~* '^https?://'),
  title       text not null default '',
  source      text not null default '',
  thumbnail   text not null default '',
  description text not null default '',
  created_at  timestamptz not null default now(),
  unique (user_id, url)
);

create index if not exists videos_user_created_idx on public.videos (user_id, created_at desc);

alter table public.videos enable row level security;

drop policy if exists "videos: ver los propios" on public.videos;
drop policy if exists "videos: crear los propios" on public.videos;
drop policy if exists "videos: editar los propios" on public.videos;
drop policy if exists "videos: borrar los propios" on public.videos;

create policy "videos: ver los propios" on public.videos
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "videos: crear los propios" on public.videos
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "videos: editar los propios" on public.videos
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "videos: borrar los propios" on public.videos
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Solo usuarios con sesión iniciada; los visitantes anónimos no tienen acceso.
revoke all on public.videos from anon;
grant select, insert, update, delete on public.videos to authenticated;
