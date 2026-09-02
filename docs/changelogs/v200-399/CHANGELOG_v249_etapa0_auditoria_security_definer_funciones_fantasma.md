# v249 — Etapa 0 (Higiene de base): auditoría automática de SECURITY DEFINER + funciones fantasma

## Contexto
Del plan por etapas, quedaban dos ítems sueltos de Etapa 0:

1. Script de auditoría automática de grants `SECURITY DEFINER`, para que el
   patrón de fuga cross-tenant de v124/v194 (vistas sin `security_invoker`)
   y v135/v136/v142 (RPCs sin chequeo de `empresa_id` grantadas a
   anon/authenticated) se detecte solo en vez de por casualidad.
2. Barrido `pg_proc` vivo vs. todo lo trackeado en el repo, para no perder
   más funciones "fantasma" como `forzar_cierre_turno_caja` (trackeada
   recién en la 241).

## Cambios

- **`supabase/migrations/249_etapa0_audit_security_definer_y_funciones_fantasma.sql`**
  — 3 RPCs nuevas, todas `SECURITY DEFINER` pero con `GRANT EXECUTE` **solo**
  a `service_role` (anon/authenticated no pueden llamarlas):
  - `audit_security_definer_grants()` — funciones `SECURITY DEFINER` en
    `public`, si tienen `search_path` fijo, si anon/authenticated pueden
    ejecutarlas, y heurística de si filtran por `empresa_id`. Marca
    `riesgo_potencial` cuando es invocable públicamente sin evidencia de
    filtro por tenant.
  - `audit_views_security_invoker()` — vistas sin `security_invoker=true`
    expuestas a anon/authenticated (patrón exacto de v124/v194).
  - `audit_funciones_vivas()` — listado de funciones vivas en `public`
    (nombre, firma, si es `SECURITY DEFINER`, hash del cuerpo) para
    diffear contra el repo.

- **`scripts/audit-security-grants.js`** — corre las dos primeras RPCs,
  reporta con colores (mismo estilo que `check-schema.js`), `--json` para
  CI. Exit 1 si hay `riesgo_potencial=true` en algún resultado.

- **`scripts/audit-funciones-fantasma.js`** — extrae todos los
  `CREATE (OR REPLACE) FUNCTION nombre(` de `supabase/migrations/*.sql`,
  los cruza contra `audit_funciones_vivas()`, y lista lo que vive en la
  base pero no tiene ningún `CREATE FUNCTION` rastreable en el repo.
  Ignora funciones de extensiones (`gen_random_uuid`, `crypt`, etc.).
  Exit 1 si encuentra fantasmas.

- **`package.json`** — nuevos comandos: `audit:security`,
  `audit:security:json`, `audit:funciones-fantasma`,
  `audit:funciones-fantasma:json`, `audit:all`. Quedan fuera de
  `predeploy` a propósito: ese script hoy corre sin credenciales de DB
  (solo filesystem) y estas dos RPCs necesitan
  `SUPABASE_SERVICE_ROLE_KEY`.

## Pendiente
- Aplicar la migración 249 en producción.
- Correr `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run audit:all`
  una vez aplicada, y revisar los hallazgos reales contra la base (esta
  entrega no corrigió nada todavía — solo agrega la detección).
- Decidir si `audit:all` se suma a `predeploy` (requiere exponer
  `SUPABASE_SERVICE_ROLE_KEY` en el entorno de build/CI).
