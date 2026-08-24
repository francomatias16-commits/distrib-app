# CHANGELOG v814 — P2 Lote 3: rate limit distribuido, webhook MP, push fail-closed, XSS saas-billing

**Base:** `distrib_v813_remediado_2026` (equivalente a `distrib_v817_remediado_2026` de la auditoría integral 2026, con un changelog adicional).
**Origen del parche:** `files__1_.zip` (Lote 3 de remediación P2), aplicado completo sobre la base anterior.

## Resumen

Se incorporan los cinco artefactos de Lote 3 que todavía no estaban en la base `v813`/`v817_remediado`:

| Archivo | Hallazgo | Cambio |
|---|---|---|
| `lib/rate-limit.js` | SEC-07 / DT-04 | El contador de rate limiting pasa de un `Map` en memoria (por instancia, inefectivo en serverless multi-instancia) a un contador atómico en Postgres (`rate_limits` + `rl_check_and_increment`, `INSERT ... ON CONFLICT ... DO UPDATE`). Si Supabase no responde, degrada a un `Map` local como red de contención best-effort, con log de aviso. |
| `supabase/migrations/20260817_p2_lote3_webhook_ratelimit_push_xss.sql` | SEC-07 | Migración que crea `public.rate_limits` (con índice sobre `reset_at`) y la función `rl_check_and_increment` que respalda el nuevo `lib/rate-limit.js`. |
| `lib/handlers/pagos.js` | SEC-10 / BUG-01 | Refuerza la validación del webhook de Mercado Pago y agrega un UPDATE condicional (CAS) para que un webhook y un polling concurrentes no puedan pisarse el estado del pago ni duplicar el `offline_local_id`. |
| `lib/repos/pagos.js` | SEC-10 / BUG-01 | Contraparte a nivel repositorio del CAS anterior: la consulta que antes podía dar falsos negativos de "no hay transacción para este pedido" ahora es consistente con el nuevo flujo condicional del handler. |
| `lib/handlers/notif.js` | SEC-14 | El envío de push deja de aceptar indefinidamente el header legado `x-trigger: supabase` (valor fijo y público) como sustituto de `INTERNAL_PUSH_SECRET`. Ahora es fail-closed: sin `INTERNAL_PUSH_SECRET` configurada, se rechaza con 503 en vez de aceptar el header legado; con la variable configurada, se exige `x-push-secret` sin excepción. |
| `frontend/admin/saas-billing.html` | SEC-06 (XSS almacenado) | Sanitiza nombre/email antes de insertarlos en el DOM del panel de facturación SaaS, cerrando el vector de XSS almacenado. |

## Validación

- `node --check` sin errores en los 4 archivos `.js` modificados.
- La migración es idempotente (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) y no pisa las 7 migraciones de fecha `20260817` ya presentes en la base (`auditoria_2026_security_definer`, `factura_cae_reconciliacion`, `nc_atomic_persist`, `reactivar_trigger_saldo_puntos`, `fix_demo_cron_and_stock_report`, `devolucion_item_reintento`, `presupuesto_atomic_number`).

## Pendiente (no incluido en este merge)

- Ejecutar la migración en el proyecto Supabase real (QA/producción) — no se aplicó DDL/DML fuera de este entregable.
- Verificación funcional del webhook de Mercado Pago y del flujo de push contra un entorno desplegado.
- Existe un `saas-billing.html` duplicado en la raíz del proyecto (distinto de `frontend/admin/saas-billing.html`, más viejo — no tiene los `<link>/<script>` de `responsive-mobile`). El parche de Lote 3 solo tenía como destino `frontend/admin/saas-billing.html`; el duplicado de la raíz no fue tocado y conviene revisarlo aparte (posible archivo obsoleto).
