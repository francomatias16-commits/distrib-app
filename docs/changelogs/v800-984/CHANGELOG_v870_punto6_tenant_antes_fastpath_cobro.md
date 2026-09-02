# CHANGELOG v870 — Auditoría 2026, Fase A, Punto 6 (cierre)

**Sincronización de repo:** este changelog documenta la migración `509_tenant_antes_de_fastpath_cobro.sql`, aplicada directamente en Supabase en una sesión anterior a este ZIP (el snapshot que llegó a esta sesión todavía no la traía como archivo). Sin cambios de código pendientes de deploy — es 100% SQL, ya en producción.

## Qué cambió

`registrar_cobro_completo()`: la validación de tenant (`p_empresa_id = get_empresa_id()`) y de rol pasa a correr **antes** del fast-path de idempotencia por `offline_local_id` (antes corría después).

Los tres call sites reales (chofer al confirmar entrega, webhook/polling de Mercado Pago, reconciliación de la cola de tareas) siempre resuelven `p_empresa_id` server-side — no era una vulnerabilidad explotada, pero es la RPC financiera más sensible que quedaba sin este reordenamiento (mismo patrón que el punto 5, migración 508, ya aplicó en `ajustar_stock`/`registrar_conteo_stock`/`transferir_stock`).

Sin cambios de comportamiento para callers legítimos.

## Migración

`supabase/migrations/509_tenant_antes_de_fastpath_cobro.sql` — aplicada en producción, verificada.

## Estado del plan (Fase A — asegurar el motor financiero)

| # | Punto | Estado |
|---|-------|--------|
| 6 | Validación de tenant antes de fast-paths | ✅ RESUELTO |
