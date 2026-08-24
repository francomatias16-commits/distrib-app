# CHANGELOG v871 — Auditoría 2026, Fase A, Punto 7 (cierre)

## Qué cambió

**Idempotencia en pagos de proveedores** — `registrar_pago_proveedor()` no tenía ningún mecanismo contra reintentos (a diferencia de cobros y ajustes de stock, ya cerrados en los puntos 5/6). Un timeout de red, un doble click, o un futuro retry automático podían duplicar un pago real.

### DB (migración 510, aplicada en producción)

- `pagos_proveedor.offline_local_id` (columna nueva, `TEXT`, nullable).
- Índice único parcial `idx_pagos_proveedor_offline_local_id` sobre `(empresa_id, offline_local_id) WHERE offline_local_id IS NOT NULL` — mismo patrón que `idx_cobros_offline_local_id`.
- `registrar_pago_proveedor()`: nuevo parámetro `p_offline_local_id`. El fast-path de idempotencia corre **después** de validar tenant/rol y **antes** de leer/bloquear la factura — mismo orden que dejó cerrado el punto 6 en `registrar_cobro_completo` (migración 509). Nota técnica: el parámetro nuevo obligó a un `DROP FUNCTION` explícito de la firma vieja de 10 argumentos antes del `CREATE OR REPLACE`, porque Postgres lo trata como un overload distinto si no coinciden los tipos — si no, quedaba una firma fantasma y `REVOKE`/`GRANT`/`COMMENT` sin argumentos quedaban ambiguos. Verificado post-aplicación: una sola firma en `pg_proc` (11 argumentos).

### Backend (`lib/handlers/cc_proveedores.js`)

- Acepta `offline_local_id` del body y lo reenvía como `p_offline_local_id`.
- La auditoría (`AuditRepo.registrarAuditoriaSilenciosa`) se omite cuando la respuesta trae `ya_existia: true` — mismo patrón que `pos.js`/`pedidos.js` para no reemitir auditoría sobre un reintento que no escribió nada nuevo.

### Frontend (`frontend/admin/js/cc-proveedores.js`)

- `guardarPago()` genera un `offline_local_id` (`crypto.randomUUID()`) una sola vez por intento de pago y lo manda en el body — mismo mecanismo que `offline-core.js`. El botón ya se deshabilitaba contra el doble click en la misma carga de página; esto además cubre un timeout de red con reintento, o un reenvío accidental del mismo submit.

Este flujo hoy solo se usa desde el panel admin (no hay outbox offline todavía para pagos a proveedores), pero queda listo para cuando el portal de pagos a proveedores sume soporte offline.

## Verificado

- `node --check` sobre los 3 archivos JS tocados.
- Suite de tests (`tests/repos/cc-proveedores.test.js`, `tests/permisos-service.test.js`): 299 tests, todos verdes — `registrarPagoProveedorRpc` sigue siendo un passthrough genérico, no requirió cambios.
- Firma de la función en producción verificada por SQL directo: `registrar_pago_proveedor(uuid,uuid,uuid,numeric,text,date,text,text,uuid,uuid,text)`, única.

## Migración

`supabase/migrations/510_idempotencia_pago_proveedor.sql` — aplicada en producción, verificada.

## Estado del plan (Fase A — asegurar el motor financiero)

| # | Punto | Estado |
|---|-------|--------|
| 7 | Idempotencia en pagos de proveedores | ✅ RESUELTO |
| 8 | Auditoría financiera durable | ⬜ Pendiente de iniciar |

## Próximo paso sugerido

Punto 8 — auditoría financiera durable: reemplazar `registrarAuditoriaSilenciosa` (que absorbe fallos en silencio) por un outbox con reintentos, para las escrituras financieras (cobros, pagos a proveedor, ajustes de stock) — mismo criterio de "no perder el rastro de la plata" que motivó los puntos 5-7.
