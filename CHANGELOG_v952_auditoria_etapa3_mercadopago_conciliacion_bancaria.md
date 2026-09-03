# v952 — Auditoría etapa 3: Pagos online (Mercado Pago) + Conciliación bancaria

Continuación de `PLAN_AUDITORIA_FUNCIONAL_PRELANZAMIENTO_2026.md`, etapa 3
("Pagos online (Mercado Pago) + Conciliación bancaria + Gastos generales").
Gastos generales ya había quedado cerrado en v951 (fecha UTC + etiqueta
recurrente). Esta sesión cierra el resto de la etapa: revisión de
`lib/handlers/pagos.js` (2792 líneas), `lib/repos/pagos.js`,
`frontend/admin/js/pos-terminal.js` (driver `mp_qr` y el resto de
terminales que comparten pantalla), `frontend/admin/mercadopago-config.html`,
y el módulo completo de conciliación bancaria (`lib/handlers/` +
`lib/repos/` + `frontend/admin/js/conciliacion-bancaria.js`), contrastando
además contra el estado real de producción (proyecto `jgiquzjwoedmzwqgzubr`)
vía MCP.

## Resultado: sin bugs funcionales nuevos

Ambos módulos ya venían de varias rondas de auditoría previas, bien
documentadas en el propio código con sus tags (`BUG-01`, `SEC-10`,
`MERCADOPAGO-AUDIT-01`, `DT-04`, `SEC-013` en `pagos.js`;
`CONCILIACION-AUDIT-01`/`02` y el fix de v899 en conciliación bancaria).
Se revisó puntualmente:

- **Idempotencia del webhook de MP** (CAS en `transacciones_pago` +
  dedup por `offline_local_id` en `registrar_cobro_completo`): correcta,
  cubre tanto reintentos de MP como carreras webhook/polling.
- **Verificación de firma HMAC** (`verificarFirmaMP`): fail-closed,
  `timingSafeEqual`, sin secreto no pasa nada — correcta.
- **Flujo QR del POS** (`pos-qr-cobrar` → Realtime → `pos-qr-verificar`
  como red de contención): mapeo de estados de la Orders API
  (`_estadoOrdenMP`) consistente entre backend y frontend
  (`fila.estado === 'aprobado'`), sin el patrón de mismatch que causó el
  bug de conciliación bancaria (checkeado a propósito, ver hallazgo de
  abajo).
- **Guardado/validación de credenciales, OAuth, desconexión**
  (`mercadopago-config.html`): sin hallazgos — el access_token nunca
  vuelve al frontend, la config de QR queda oculta sin cuenta conectada.
- **Conciliación bancaria** (`conciliacion-bancaria.js`, handler + repo +
  las 4 RPC de matching): confirmado que los 3 fixes de rondas previas
  (`MAX(uuid)` → `array_agg`, CHECK de `estado` sin `'descartado'`, falta
  de filtro por `tipo` en `conciliacion_buscar_candidatos`) siguen
  aplicados y correctos contra el código actual — no se encontró un 4to
  caso.

## Único hallazgo real: gap de versionado (no de lógica)

`cobros_qr_pos` — la tabla puente que usa el webhook de MP (topic
`order`) para avisarle al POS por Realtime que un QR se pagó — existe y
está en uso real en producción, pero **nunca tuvo su propio archivo de
migración en el repo** (mismo patrón de "disaster-recovery gap" ya
encontrado en v880/v892/v899). Reconstruida en
`supabase/migrations/20260902_fix_cobros_qr_pos_reconstruccion.sql` a
partir del estado real de la base (columnas, índices —incluye el
`UNIQUE` sobre `order_id`, confirmado antes de asumirlo—, trigger de
`updated_at` y las 4 políticas RLS) verificado 1 a 1 vía MCP. Sin cambios
de esquema real: el script es 100% idempotente (`IF NOT EXISTS` /
`DROP POLICY IF EXISTS` + `CREATE POLICY`), ya aplicado y verificado
contra producción, y registrado en `schema_migrations_registry`.

## Con esto, la etapa 3 del plan de auditoría funcional queda cerrada

Sigue el pase manual en navegador real (etapa 5 del plan) y el resto de
admin de menor riesgo (etapa 6) como pendientes generales del plan
maestro — no específicos de esta sesión.
