# CHANGELOG v234 — Fixes Etapa 2 (Topbar / Reloj / Avatar — integridad Supabase)

Aplicado sobre distrib v233, en base a
`Auditoria_Etapa2_Topbar_Reloj_Avatar_distrib_v232.docx` (esquema cruzado
en vivo contra el proyecto Supabase `jgiquzjwoedmzwqgzubr`).

## [Crítica] RLS de `empresas` exponía todas las empresas activas sin auth

`supabase/migrations/232_fix_auditoria_etapa2_rls_empresas_activo_grants.sql`
(nueva). La policy `empresas_select_propio`, modificada en
`050_fix_activo_rls_v53.sql`, tenía `USING (id = get_empresa_id() OR activa
= true)`. Con la anon key pública (embebida en `frontend/env-config.js`),
cualquiera sin login podía hacer `GET /rest/v1/empresas?select=*` y leer
**todas** las columnas de todas las empresas activas del SaaS, incluyendo
`saas_cbu` / `saas_alias` (datos bancarios) y datos de plan/precio/trial.

Se revirtió a `USING (id = get_empresa_id())` y se creó
`public.v_empresas_publico` (solo `id, nombre, logo_url`, `WHERE activa =
true`) para las dos pantallas que sí necesitan mostrar marca sin sesión.

**⚠️ Acción requerida:** correr esta migración contra el proyecto
`jgiquzjwoedmzwqgzubr` antes de desplegar el código de esta release — el
código nuevo de `login.html` asume que `v_empresas_publico` ya existe.

## [Alta] `usuarios.activo` no se validaba en ningún lado

- `frontend/admin/js/auth.js`: el `select` de perfil ahora incluye
  `.eq('activo', true)`; si el usuario fue desactivado, se cierra sesión y
  redirige a `/admin/login?error=usuario_inactivo` en vez de dejarlo operar
  el panel con el JWT viejo.
- Migración `232_...sql`: `get_empresa_id()` y `get_rol_usuario()` (usadas
  en todas las policies de RLS del sistema) ahora exigen `activo = true`.
  Esta es la capa que realmente cierra el hueco — la de `auth.js` es
  defensa en profundidad para dar un mensaje claro en el login.

Nota: la revocación de sesión activa al desactivar un usuario (Admin API de
Supabase Auth) queda **pendiente** — hoy con estas dos capas el usuario
desactivado pierde acceso a los datos en el siguiente request (RLS lo
bloquea), pero su JWT sigue siendo válido hasta expirar.

## [Media] Grants excesivos de `anon` sobre `empresas` / `usuarios`

Migración `232_...sql`: `REVOKE INSERT, UPDATE, DELETE, TRUNCATE,
REFERENCES, TRIGGER ON public.empresas, public.usuarios FROM anon`. Se
verificó que ningún flujo público (`/api/registro`, altas desde
`superadmin.html`, cambios de plan en `saas-billing.html`) depende de estos
grants: todos corren vía `service_role` (bypassa RLS/grants) o requieren
sesión (`authenticated`), no `anon`.

## [Media] Inyección de filtro PostgREST en el buscador global

`lib/handlers/busqueda.js`: `q` se interpolaba crudo dentro de los strings
de `.or(...)`. Se agregó `escaparFiltroPostgrest()` que escapa `, ( ) *`
antes de armar el patrón `like`. El escape de salida (XSS) ya estaba bien
hecho en `busqueda-global.js` vía `esc()`/`highlight()` — no se tocó.

## [Baja] Iniciales del avatar con caracteres no alfabéticos

`frontend/shared/topbar-widgets.js`: `mejorarChipUsuario()` tomaba
`palabra[0]` crudo. Ahora usa `\p{L}` (primera letra Unicode real de cada
palabra) y descarta palabras sin ninguna letra, evitando iniciales "basura"
si el nombre arranca con emoji/número/símbolo.

## [Baja] `.topbar-usuario` sin truncar (a diferencia de `.topbar-title`)

`frontend/shared/adminlte-components.css`: se agregó `max-width: 220px` +
`text-overflow: ellipsis` + `white-space: nowrap` a `.topbar-usuario` para
evitar desborde de `.topbar-right` con nombres largos (`usuarios.nombre` es
`text` sin límite en la base).

## [Baja] `docs/schema-snapshots/*.sql` desactualizado — 10 columnas faltantes

**Pendiente de ejecución manual** (requiere `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` contra la DB viva, no disponibles en este
entorno de trabajo): correr `node scripts/check-schema.js` o
`pg_dump --schema-only` y regenerar `docs/schema-snapshots/` como parte del
flujo de release. El snapshot actual de `empresas` no incluye `saas_plan`,
`saas_suspendida`, `saas_suspendida_at`, `saas_cbu`, `saas_alias`,
`setup_completado`, `plan_tier`, `es_demo`, `supervisor_pin`,
`saas_trial_fin`, `saas_precio_mes` — todas usadas activamente por
`auth.js`. No es una falla de datos; es riesgo de que una auditoría o un
desarrollador nuevo razone sobre el sistema con información incorrecta.

## Archivos tocados

- `supabase/migrations/232_fix_auditoria_etapa2_rls_empresas_activo_grants.sql` (nuevo)
- `frontend/admin/js/auth.js`
- `frontend/admin/login.html`
- `frontend/cliente/login.html`
- `frontend/shared/topbar-widgets.js`
- `frontend/shared/adminlte-components.css`
- `lib/handlers/busqueda.js`

## Pendiente (fuera de esta tanda)

- Revocación de sesión (Admin API de Supabase Auth) al desactivar un usuario.
- Regenerar `docs/schema-snapshots/` desde la DB viva.
- Evaluar si conviene revocar también los grants amplios de `authenticated`
  sobre `empresas`/`usuarios` y reemplazarlos por grants acotados a las
  columnas que cada policy de `UPDATE` realmente necesita.
