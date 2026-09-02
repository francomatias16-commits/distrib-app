# v892 — Punto 8 (Fase A, auditoría financiera 2026): auditoría durable

Continuación del cierre de la Fase A del audit de motor financiero
(Puntos 6 y 7 ya cerrados en v891). Este entrega cierra el Punto 8 y
además repara un gap de disaster-recovery detectado al retomar la sesión.

## Gap encontrado (antes de poder cerrar el Punto 8)

El ZIP consolidado v891 tenía los 3 archivos ya editados de la sesión
anterior (`cc_proveedores.js`, `pos.js` parcial), pero **no traía
`lib/repos/audit.js` reescrito ni las migraciones 509 y 511** — ambas
aplicadas en producción, pero nunca versionadas en el repo. Mismo patrón
de "disaster-recovery gap" ya documentado en `AUDITORIA_2026/` para otras
migraciones.

Se reconstruyeron los tres artefactos directamente desde el estado real
de producción (Supabase MCP, proyecto `jgiquzjwoedmzwqgzubr`):

- `supabase/migrations/509_tenant_antes_de_fastpath_cobro.sql`: recuperado
  con `pg_get_functiondef(registrar_cobro_completo)`.
- `supabase/migrations/511_audit_log_pendientes_outbox.sql`: recuperado
  desde `information_schema.columns` + `pg_indexes` de la tabla real
  `audit_log_pendientes`.
- `lib/repos/audit.js`: no existe en la base (es código de aplicación,
  no SQL) — se reconstruyó a partir de: (a) la firma exacta que ya usan
  los call sites financieros ya editados (`registrarAuditoriaFinancieraDurable`,
  visible en `cc_proveedores.js`/`pos.js`), (b) el esquema real de
  `audit_log_pendientes` (columnas `estado`/`intentos`/`procesando_desde`/
  `ultimo_error`), y (c) el patrón de claim atómico + lease + tope de
  reintentos ya existente en `lib/eventos-dispatcher.js`
  (`reclamarEventos`/`despacharPendientes`), que es la referencia que la
  sesión anterior había ido a mirar ("Ver despacharPendientes completo
  para el patrón de claim atómico") antes de que se cortara.

## Punto 8 — Auditoría financiera durable (cerrado)

`registrarAuditoriaSilenciosa` (lib/repos/audit.js) descarta el error en
silencio si el INSERT en `audit_log` falla — aceptable para auditoría de
UI (config, favoritos, promociones), pero no para dinero real moviéndose.

- Nueva función `registrarAuditoriaFinancieraDurable`: mismo contrato
  "nunca lanza" que la variante silenciosa, pero si el INSERT directo en
  `audit_log` falla, encola el mismo registro en `audit_log_pendientes`
  (migración 511) en vez de descartarlo.
- Nueva función `reprocesarAuditoriaPendientes`: reintenta los pendientes
  encolados. Mismo patrón de claim atómico (UPDATE condicionado al estado
  leído, optimistic concurrency) + lease de 2 minutos + tope de 5
  intentos (dead-letter) que `eventos_negocio`.
- Nuevo cron `audit-log-reprocesar-cron` (`lib/handlers/notif.js`,
  wiring en `vercel.json`, corre `40 3 * * *`) — mismo esquema de auth
  (`CRON_SECRET`) que `eventos-reprocesar-cron`/
  `whatsapp-salientes-reprocesar-cron`.
- Los 9 call sites financieros identificados en la sesión anterior
  ("Identificó transacciones financieras críticas") migrados a la
  variante durable:
  - `cc_proveedores.js`: pago a proveedor (INSERT `pagos_proveedor`).
  - `pos.js`: venta (INSERT `ventas_pos`), anulación de venta (UPDATE
    `ventas_pos`), movimiento de caja manual (INSERT `movimientos_caja`),
    devolución (INSERT `devoluciones_pos`).
  - `pagos.js`: cambio de estado de pago Mercado Pago tanto por polling
    como por webhook (UPDATE `transacciones_pago`, 2 sitios), cobro
    aplicado vía Mercado Pago tanto por polling como por webhook (INSERT
    `cta_cte`, 2 sitios).
  - El resto de los call sites de auditoría en `pos.js`/`pagos.js`
    (config de integraciones de pago, cajas, turnos, favoritos,
    promociones, flags de `pedidos`) se dejaron en
    `registrarAuditoriaSilenciosa` a propósito: no son dinero moviéndose,
    son metadata/config.

## Tests

- `tests/repos/audit.test.js`: 8 tests nuevos (antes 6, ahora 14) cubriendo
  `registrarAuditoriaFinancieraDurable` (insert directo OK, fallback al
  outbox, doble fallo sin lanzar, excepción real) y
  `reprocesarAuditoriaPendientes` (reintento exitoso → procesado sin
  borrar, reintento fallido → error + `ultimo_error`, dead-letter al
  llegar al tope, dead-letter real ya no se reclama).
- `npx vitest run`: 999 tests verdes (999/1003 — los 4 que fallan son
  preexistentes, no tocados en esta entrega: `eventos-dispatcher.test.js`
  [mock desactualizado contra un `.or()` que reemplazó a `.in()`],
  `empresas.test.js` [falta `slug` en el mock, migración 501 ya lo
  agrega a la tabla real], `migracion.test.js` [mock de `.limit()`]).
- `node --check` OK en los 4 archivos de código tocados.
- `npm run check-api-wiring` / `check-handler-dispatch`: OK, el nuevo
  cron está cableado end-to-end.
- `npm run check:migrations`: OK, sin colisiones de contenido entre 509/511
  reconstruidas y el resto del repo.

## Archivos tocados

- `lib/repos/audit.js` (reescrito completo)
- `lib/handlers/pos.js` (2 sitios financieros que faltaban + los 2 ya
  cerrados en v891, sin cambios)
- `lib/handlers/pagos.js` (4 sitios financieros)
- `lib/handlers/cc_proveedores.js` (sin cambios respecto a v891, ya
  estaba cerrado)
- `lib/handlers/notif.js` (nuevo handler + wiring de router)
- `vercel.json` (rewrite + cron)
- `supabase/migrations/509_tenant_antes_de_fastpath_cobro.sql` (nuevo, reconstruido)
- `supabase/migrations/511_audit_log_pendientes_outbox.sql` (nuevo, reconstruido)
- `tests/repos/audit.test.js` (8 tests nuevos)
