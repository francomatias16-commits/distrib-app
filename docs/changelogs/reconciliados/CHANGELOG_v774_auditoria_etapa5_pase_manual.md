# v774 — Auditoría funcional etapa 5: pase manual en navegador real

Sigue a `PLAN_AUDITORIA_FUNCIONAL_PRELANZAMIENTO_2026.md` (v768), etapa 5:
el pase manual contra Supabase real que quedó pendiente de las 3 auditorías
previas (`AUDITORIA_2026/etapas`, `etapas_modulos`, `etapas_paginas`),
que hasta ahora fueron 100% análisis estático de código.

## Reconciliación del repo con producción

El ZIP de arranque de esta sesión (`v773_etapa4_portales`) traía un
checkpoint anterior a los últimos artefactos del pase manual, ya aplicados
en producción. Se reconstruyeron desde
`supabase_migrations.schema_migrations` (fuente de verdad) los 4 archivos
de migración faltantes en `supabase/migrations/` — 489, 490, 491, 492 — y
se aplicó el fix del checker `scripts/smoke-test-frontend.js` que ya
estaba en producción (reconoce `location.replace(...)` sin el prefijo
`window.`, corrigiendo un falso positivo en `liquidacion.html`).

## Checks estáticos — todos OK

Corrido el pipeline `predeploy` completo contra el repo reconciliado:
`check-migraciones-registro` (352 archivos, 0 colisiones),
`smoke-test-frontend` (37 páginas, 0 fallos), `check-asset-wiring`,
`check-api-wiring`, `check-handler-dispatch` — sin hallazgos.

## Hallazgo 1 (PORTAL-CLIENTE-AUDIT-01, crítico) — migración 491

`pedidos_update` y `pedidos_insert` solo verificaban
`empresa_id = auth_empresa_id()`, sin el mismo scoping por
rol/cliente_id que ya tenía `pedidos_select_unificada`. Cualquier usuario
autenticado con `rol='cliente'` podía, llamando directo al SDK de
Supabase desde la consola del navegador (JWT propio + anon key, ya
cargados en cualquier página del portal cliente), actualizar o insertar
filas de `pedidos` de **otro** cliente de la misma empresa. El flujo
normal de la app no lo explota (el checkout real pasa por `/api/pedidos`
con `service_role`), pero era una vulnerabilidad real y directamente
explotable, no defensa en profundidad. Fix: mismo criterio de scoping
que `pedidos_select_unificada`.

## Hallazgo 2 (34 funciones fantasma) — migración 492

`audit-funciones-fantasma.js` (vía `audit_funciones_vivas()`, migración
249) comparó las funciones vivas en `public` contra los `CREATE FUNCTION`
del repo: 34 funciones existían en producción sin ningún archivo de
migración que las creara — un `supabase db reset` no las recuperaría.
Mismo patrón que `forzar_cierre_turno_caja` (mencionada como "trackeada
en la 241", migración que en realidad nunca existió en este repo). Se
trackearon las 34 con `CREATE OR REPLACE FUNCTION` idéntico al que hoy
vive en producción (capturado con `pg_get_functiondef`) — migración
puramente de trazabilidad, sin cambio de comportamiento. Dos de las 34
(`conciliar_lote_bancario`, `conciliar_movimiento_manual`) son una
implementación vieja de conciliación bancaria, superseded por
`conciliacion_auto_matchear_lote` / `conciliacion_confirmar_match`
(etapa 3) — se trackearon igual, sin decidir un DROP unilateral.

Verificado post-fix: 0 funciones fantasma (264 vivas, 276 nombres
trackeados en el repo).

## Hallazgo 3 (5 funciones SECURITY DEFINER sin tenant check) — migración 493

`audit_security_definer_grants()` marcó 10 funciones con `riesgo_potencial`.
6 eran falsos positivos heurísticos (auto-escopadas por `auth.uid()` o con
su propio chequeo interno de rol: `auth_usuario_id`, `auth_usuario_rol`,
`chofer_clientes_ids`, `es_admin`, `es_chofer`, `get_saas_panel_admin`).
Las otras 5 eran hallazgos reales — `SECURITY DEFINER` con `EXECUTE`
otorgado a `anon`/`authenticated` (vía PostgREST, con solo la anon key
pública) y sin ningún chequeo de tenant/auth en el cuerpo:

- `conciliar_lote_bancario` / `conciliar_movimiento_manual`: legacy sin
  auth alguno, `EXECUTE` a `PUBLIC`+`anon`+`authenticated` — cualquiera
  podía manipular conciliación bancaria de cualquier empresa.
- `fn_lotes_consumir_fefo`: mismo problema — permitía vaciar stock de
  lotes de cualquier empresa sin login.
- `fn_incrementar_contador_api`: `EXECUTE` a `authenticated` sin chequeo
  de rol — cualquier usuario autenticado podía inflar contadores de uso
  de APIs pagas (Serper) de la empresa.
- `limpiar_whatsapp_reset_codigos_expirados`: bajo riesgo real (solo
  borra códigos ya vencidos), revocado por higiene.

Verificado contra el código antes de revocar: ninguna de las 5 se llama
desde el frontend (`grep` en `lib/`, `api/`, `frontend/`, `scripts/`);
`fn_incrementar_contador_api` solo se invoca server-side con
`service_role` (`lib/repos/auto-imagenes.js`). Se revocó `EXECUTE` de
`PUBLIC`/`anon`/`authenticated` en las 5 — quedan accesibles solo vía
`service_role`. Verificado post-fix: 0 hallazgos de riesgo reales
pendientes (los 6 falsos positivos heurísticos se mantienen, son
correctos como están).

## Estado

Predeploy 100% OK · 0 funciones fantasma · 0 hallazgos de seguridad
reales pendientes · 353 migraciones en el repo, sin colisiones.
Etapa 5 del plan de auditoría funcional cerrada.
