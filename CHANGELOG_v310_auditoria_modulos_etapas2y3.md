# CHANGELOG v310 — Auditoría de módulos, etapas 2 y 3 (Stock, Cta. cte.)

Este zip es el original (`distrib_v307_deploy_consolidado.zip`) con estos
cambios integrados. Ver detalle completo en
`AUDITORIA_2026/etapas_modulos/02_stock_depositos.md` y
`03_cta_cte_cobros.md`.

## Archivos modificados
- `lib/handlers/stock.js` — ajuste manual de stock ahora usa la RPC
  `ajustar_stock()` (aislada por empresa, atómica) en vez de lógica manual;
  alta de lote valida depósito de la empresa.
- `frontend/admin/js/stock.js` — transferencia entre depósitos revierte
  automáticamente si falla el segundo paso (antes podía perder stock sin
  avisar); mensaje de error accionable en vez de "verificá la consola".
- `lib/handlers/notif.js` — rate limit agregado al envío de estado de
  cuenta por email; el campo de email manual del modal de estado de
  cuenta ahora sí tiene efecto (antes el backend lo ignoraba).
- `frontend/admin/js/cta-cte.js` — aviso en consola si el fallback de
  listado trunca en 1000 facturas.
- `AUDITORIA_2026/etapas_modulos/00_INDICE.md`,
  `02_stock_depositos.md` (nuevo), `03_cta_cte_cobros.md` (nuevo).

## Base de datos (Supabase)
Ya aplicado directo en producción, sin acción pendiente:
- `fix_etapa2_h1_ajustar_stock_service_role_callers` — `ajustar_stock()`
  acepta `p_usuario_id` opcional y permite llamadas `service_role` (backend)
  sin depender de `auth.uid()`, manteniendo el chequeo de empresa/rol para
  llamadas de sesión normal (frontend).

## Pendiente
- `git push` / deploy a Vercel para que los fixes de código tengan efecto
  (la parte de base de datos ya está viva).
- Etapas 4 a 12 de esta auditoría de módulos siguen pendientes — ver
  `AUDITORIA_2026/etapas_modulos/00_INDICE.md` para el orden y cómo
  continuar en una sesión nueva.
