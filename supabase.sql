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
  category    text not null default '' check (char_length(category) <= 40),
  created_at  timestamptz not null default now(),
  unique (user_id, url)
);

-- Para proyectos creados antes de que existieran las categorías.
alter table public.videos
  add column if not exists category text not null default ''
  check (char_length(category) <= 40);

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

-- ---------- Categorías ----------
-- Cada usuario crea las suyas; un video puede tener una (o ninguna).

create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

-- Sin nombres repetidos por usuario ("Zelda" y "zelda" cuentan como el mismo).
create unique index if not exists categories_user_name_idx on public.categories (user_id, lower(name));

alter table public.categories enable row level security;

drop policy if exists "categorias: ver las propias" on public.categories;
drop policy if exists "categorias: crear las propias" on public.categories;
drop policy if exists "categorias: editar las propias" on public.categories;
drop policy if exists "categorias: borrar las propias" on public.categories;

create policy "categorias: ver las propias" on public.categories
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "categorias: crear las propias" on public.categories
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "categorias: editar las propias" on public.categories
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "categorias: borrar las propias" on public.categories
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.categories from anon;
grant select, insert, update, delete on public.categories to authenticated;

-- El video solo puede apuntar a una categoría de su mismo usuario.
-- Una categoría que tiene videos no se puede borrar: primero hay que cambiarlos de categoría.
-- ("no action" en vez de "restrict" para que al borrar la cuenta se borren videos y categorías sin error.)
alter table public.videos add column if not exists category_id uuid;
alter table public.videos drop constraint if exists videos_category_fk;
alter table public.videos add constraint videos_category_fk
  foreign key (category_id, user_id) references public.categories (id, user_id) on delete no action;
create index if not exists videos_category_idx on public.videos (category_id);

-- ---------- Orden manual ----------
-- Menor "position" = más arriba. Los videos nuevos reciben la menor (quedan arriba);
-- al arrastrar una tarjeta solo se cambia la suya (queda entre sus vecinas).
alter table public.videos add column if not exists position double precision;
update public.videos set position = -extract(epoch from created_at) where position is null;
alter table public.videos alter column position set default (-extract(epoch from now()));
alter table public.videos alter column position set not null;
create index if not exists videos_user_position_idx on public.videos (user_id, position);

-- Pasa a la tabla nueva las categorías escritas como texto en versiones anteriores.
insert into public.categories (user_id, name)
  select distinct on (user_id, lower(category)) user_id, category
  from public.videos where category <> ''
  on conflict do nothing;
update public.videos v set category_id = c.id
  from public.categories c
  where v.category <> '' and v.category_id is null
    and c.user_id = v.user_id and lower(c.name) = lower(v.category);

-- ---------- Fotos de perfil ----------
-- Carpeta pública "avatars" (máx. 1 MB, solo imágenes). Cada usuario solo puede
-- subir, cambiar o borrar archivos dentro de su carpeta (la que se llama como su id).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars: ver la propia" on storage.objects;
drop policy if exists "avatars: subir la propia" on storage.objects;
drop policy if exists "avatars: cambiar la propia" on storage.objects;
drop policy if exists "avatars: borrar la propia" on storage.objects;

create policy "avatars: ver la propia" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatars: subir la propia" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatars: cambiar la propia" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "avatars: borrar la propia" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
