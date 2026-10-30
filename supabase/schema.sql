-- =====================================================================
--  Agenda de turnos · Base de datos para Supabase
--  Cómo usarlo: Supabase → SQL Editor → New query → pegar todo → Run.
--  Se puede volver a ejecutar sin romper nada.
-- =====================================================================

-- Zona horaria del consultorio (para no aceptar turnos en días pasados)
create or replace function public._hoy() returns date
language sql stable as $$ select (now() at time zone 'America/Argentina/Buenos_Aires')::date $$;

-- "09:30" → 570 minutos
create or replace function public._min(t text) returns int
language sql immutable as $$ select split_part(t, ':', 1)::int * 60 + split_part(t, ':', 2)::int $$;

-- ---------------------------------------------------------------------
-- 0. Equipo del consultorio: solo estos mails pueden ver y editar turnos
--    (cargalos al final de este archivo)
-- ---------------------------------------------------------------------
create table if not exists public.equipo (email text primary key);
alter table public.equipo enable row level security;   -- nadie la lee desde la web

create or replace function public.es_equipo() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.equipo e
                 where lower(e.email) = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;
revoke all on function public.es_equipo() from public;
grant execute on function public.es_equipo() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 1. Configuración del consultorio (una sola fila)
-- ---------------------------------------------------------------------
create table if not exists public.config (
  id          int primary key default 1 check (id = 1),
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.config enable row level security;

drop policy if exists "config: todos leen" on public.config;
create policy "config: todos leen" on public.config
  for select to anon, authenticated using (true);
drop policy if exists "config: el consultorio crea" on public.config;
create policy "config: el consultorio crea" on public.config
  for insert to authenticated with check (public.es_equipo());
drop policy if exists "config: el consultorio edita" on public.config;
create policy "config: el consultorio edita" on public.config
  for update to authenticated using (public.es_equipo()) with check (public.es_equipo());

-- ---------------------------------------------------------------------
-- 2. Turnos
--    Los datos del paciente (nombre, DNI, teléfono, obra social…) van en
--    "datos" y SOLO los puede leer el consultorio con su usuario.
-- ---------------------------------------------------------------------
create table if not exists public.turnos (
  id           bigint generated always as identity primary key,
  pro          text not null,
  fecha        date not null,
  inicio       text not null check (inicio ~ '^[0-2][0-9]:[0-5][0-9]$'),
  dur          int  not null check (dur between 5 and 480),
  estado       text not null default 'pendiente'
               check (estado in ('pendiente','confirmado','asistio','ausente','bloqueo','cancelado')),
  origen       text not null default 'web',
  datos        jsonb not null default '{}'::jsonb,
  creado       timestamptz not null default now(),
  actualizado  timestamptz not null default now()
);
create index if not exists turnos_fecha_pro on public.turnos (fecha, pro);
alter table public.turnos enable row level security;

drop policy if exists "turnos: solo el consultorio" on public.turnos;
create policy "turnos: solo el consultorio" on public.turnos
  for all to authenticated using (public.es_equipo()) with check (public.es_equipo());

create or replace function public._tocar() returns trigger
language plpgsql as $$ begin new.actualizado := now(); return new; end $$;
drop trigger if exists turnos_actualizado on public.turnos;
create trigger turnos_actualizado before update on public.turnos
  for each row execute function public._tocar();

-- Avisos en tiempo real al panel cuando entra o cambia un turno
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'turnos') then
    alter publication supabase_realtime add table public.turnos;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Horarios ocupados (lo único que ve el paciente: sin datos personales)
-- ---------------------------------------------------------------------
create or replace function public.ocupados(desde date, hasta date)
returns table (pro text, fecha date, inicio text, dur int)
language sql stable security definer set search_path = public as $$
  select t.pro, t.fecha, t.inicio, t.dur
  from public.turnos t
  where t.estado <> 'cancelado'
    and t.fecha between desde and least(hasta, desde + 400)
$$;
revoke all on function public.ocupados(date, date) from public;
grant execute on function public.ocupados(date, date) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Reservar un turno desde la web
--    Controla que el horario esté dentro de la atención del profesional
--    y que nadie lo haya tomado (aunque reserven dos personas a la vez).
-- ---------------------------------------------------------------------
create or replace function public.reservar(t jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pro    text := t->>'pro';
  v_fecha  date;
  v_inicio text := t->>'inicio';
  v_dur    int;
  v_datos  jsonb := coalesce(t->'datos', '{}'::jsonb);
  v_hoy    date := public._hoy();
  v_cfg    jsonb;
  v_prof   jsonb;
  v_id     bigint;
  v_code   text;
begin
  begin
    v_fecha := (t->>'fecha')::date;
    v_dur   := (t->>'dur')::int;
  exception when others then
    raise exception 'datos_invalidos';
  end;
  if v_pro is null or v_fecha is null or v_dur is null
     or coalesce(v_inicio, '') !~ '^[0-2][0-9]:[0-5][0-9]$' or v_dur < 5 or v_dur > 240 then
    raise exception 'datos_invalidos';
  end if;
  if v_fecha < v_hoy or v_fecha > v_hoy + 400 then raise exception 'fecha_invalida'; end if;
  if coalesce(trim(v_datos->>'name'), '') = '' then raise exception 'falta_nombre'; end if;
  if length(v_datos::text) > 20000 then raise exception 'datos_muy_grandes'; end if;

  select data into v_cfg from public.config where id = 1;
  select p into v_prof from jsonb_array_elements(coalesce(v_cfg->'pros', '[]'::jsonb)) p where p->>'id' = v_pro;
  if v_prof is null then raise exception 'profesional_inexistente'; end if;

  -- días anulados (feriados, vacaciones)
  if exists (
    select 1 from jsonb_array_elements(coalesce(v_cfg->'daysOff', '[]'::jsonb)) o
    where o->>'d' = v_fecha::text and (o->>'pro' is null or o->>'pro' = v_pro)
  ) then
    raise exception 'dia_anulado';
  end if;

  -- dentro del horario de atención de ese día
  if not exists (
    select 1 from jsonb_array_elements(coalesce(v_prof->'hours'->(extract(dow from v_fecha)::int::text), '[]'::jsonb)) r
    where public._min(r->>0) <= public._min(v_inicio) and public._min(v_inicio) + v_dur <= public._min(r->>1)
  ) then
    raise exception 'fuera_de_horario';
  end if;

  -- evita que dos personas tomen el mismo horario al mismo tiempo
  perform pg_advisory_xact_lock(hashtext(v_pro || '|' || v_fecha::text));
  if exists (
    select 1 from public.turnos x
    where x.pro = v_pro and x.fecha = v_fecha and x.estado <> 'cancelado'
      and public._min(x.inicio) < public._min(v_inicio) + v_dur
      and public._min(v_inicio) < public._min(x.inicio) + x.dur
  ) then
    raise exception 'horario_ocupado';
  end if;

  v_code := upper(substr(translate(md5(random()::text || clock_timestamp()::text), '01', ''), 1, 5));
  v_datos := (v_datos - 'status' - 'id' - 'pro' - 'date' - 'start' - 'dur')
             || jsonb_build_object('code', v_code, 'isNew', true, 'source', 'web');

  insert into public.turnos (pro, fecha, inicio, dur, estado, origen, datos)
  values (v_pro, v_fecha, v_inicio, v_dur, 'pendiente', 'web', v_datos)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'code', v_code);
end $$;
revoke all on function public.reservar(jsonb) from public;
grant execute on function public.reservar(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Fotos de órdenes médicas (privadas: solo las ve el consultorio)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ordenes', 'ordenes', false, 6291456, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

drop policy if exists "ordenes: pacientes suben" on storage.objects;
create policy "ordenes: pacientes suben" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'ordenes');
drop policy if exists "ordenes: el consultorio ve" on storage.objects;
create policy "ordenes: el consultorio ve" on storage.objects
  for select to authenticated using (bucket_id = 'ordenes' and public.es_equipo());
drop policy if exists "ordenes: el consultorio borra" on storage.objects;
create policy "ordenes: el consultorio borra" on storage.objects
  for delete to authenticated using (bucket_id = 'ordenes' and public.es_equipo());

-- ---------------------------------------------------------------------
-- 6. ¿Quién es del equipo?  ← CAMBIÁ ESTE MAIL por el del consultorio
--    (el mismo que uses en Authentication → Users). Podés agregar varios.
-- ---------------------------------------------------------------------
insert into public.equipo (email) values ('consultorio@ejemplo.com')
on conflict (email) do nothing;
