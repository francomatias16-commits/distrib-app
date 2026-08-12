-- Punto 32 del plan de migraciones / P1 item 9: permite guardar un mapeo de
-- columnas (entidad + mapeo_columnas + destino de depósito/lista) como
-- plantilla reutilizable, para no tener que re-mapear a mano cada vez que el
-- cliente sube un nuevo archivo del mismo sistema origen (típico: exportaciones
-- mensuales históricas de cta_cte, o corridas repetidas de precios_clientes).
create table if not exists migracion_plantillas_mapeo (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  entidad text not null,
  nombre text not null,
  mapeo_columnas jsonb not null default '{}'::jsonb,
  deposito_id uuid,
  lista_precio_id uuid,
  creado_por uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_migracion_plantillas_empresa_entidad
  on migracion_plantillas_mapeo (empresa_id, entidad);

-- Nombre único por empresa+entidad para poder ofrecer "sobrescribir" sin
-- generar duplicados silenciosos si el usuario reusa el mismo nombre.
create unique index if not exists idx_migracion_plantillas_nombre_unico
  on migracion_plantillas_mapeo (empresa_id, entidad, lower(nombre));

alter table migracion_plantillas_mapeo enable row level security;

create policy migracion_plantillas_mapeo_empresa
  on migracion_plantillas_mapeo
  for all
  using (not (empresa_id is distinct from get_empresa_id()))
  with check (not (empresa_id is distinct from get_empresa_id()));
