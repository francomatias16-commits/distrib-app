# v1067 — Fix: cron de cheques por vencer nunca disparaba (estado equivocado) + rolado de fechas de cheques en demo

Continuación de la auditoría de "circuito de tablas" de la empresa demo (tras
el fix de `ofertas_liquidacion`/lotes). Al revisar si el mismo patrón de
fecha fija se repetía en otro lado, apareció un bug de producción real, no
solo de demo.

## Bug encontrado (producción)

`listarChequesPorVencer` (`lib/repos/notif.js`), usada por el cron
`/api/notif/cheques-por-vencer` (`handleChequesCron`), filtraba
`estado = 'pendiente'`. Ese estado nunca se usa en la práctica — el
constraint real de `cheques.estado` usa `en_cartera`, `cobrado`,
`rechazado`, `depositado`, `anulado`. El estado correcto para "cheque en
cartera, todavía sin cobrar" es `en_cartera`, tal como ya lo usa
correctamente `obtenerChequesVencidos` en `lib/repos/admin.js`.

Resultado real: el aviso de cheques por vencer no disparaba nunca, ni en
demo ni en un cliente real, aunque hubiera cheques por vencer dentro de la
ventana (`DIAS_AVISO = 3`).

Se confirmó antes de tocar nada que `vencimiento` y `fecha_vto` están
sincronizados (trigger `fn_cheques_sync_vencimiento`), así que el campo de
fecha usado por la consulta ya era el correcto — el único problema era el
filtro de `estado`.

## Fix

- `lib/repos/notif.js`: `listarChequesPorVencer` ahora filtra
  `estado = 'en_cartera'` en vez de `'pendiente'`.
- `tests/repos/notif.test.js`: test actualizado para reflejar el filtro
  correcto (`en_cartera`).

## Rolado de fechas en la empresa demo (Supabase)

Mismo patrón que lotes (v605/v606 del proyecto): `fn_redistribuir_fechas_demo`
no incluye la tabla `cheques`, así que los cheques `en_cartera` quedaban con
`fecha_vto`/`vencimiento` fijos del snapshot y, con el paso de los días
reales, se iban cayendo de la ventana de aviso — el bug de arriba se hubiera
vuelto a "auto-apagar" solo aunque se arreglara el filtro.

- Nueva función `public.fn_rodar_cheques_demo(p_empresa_id uuid)`: mismo
  criterio de spread determinístico por hash (mod 216 días) que el resto de
  `fn_redistribuir_fechas_demo`, anclado a `fecha_recepcion` (o `created_at`
  si no la tiene) para preservar el plazo real entre recepción y
  vencimiento de cada cheque. Incluye una garantía determinística: el
  cheque `en_cartera` con `fecha_vto` más próximo siempre se re-ancla a
  `hoy + 2 días`, para que el cron real de cheques por vencer siempre tenga
  al menos un insumo dentro de la ventana de 3 días.
- `fn_reset_demo_cron()` ahora invoca `fn_rodar_cheques_demo(v_empresa_id)`
  después de `fn_rodar_lotes_trigger_demo` (mismo lugar y mismo criterio que
  el resto del rolado de demo).

## Validado en esta sesión

- `npx vitest run tests/repos/notif.test.js` — 53 tests, todos en verde.
- `npx vitest run` (suite completa) — **138 test files, 1969 tests, todos en
  verde**.
- En Supabase: se ejecutó `fn_rodar_cheques_demo` manualmente sobre la
  empresa demo y se confirmó que queda al menos un cheque `en_cartera` con
  `vencimiento` dentro de la ventana de 3 días (dos cheques cayeron el
  2026-09-11, a 2 días de hoy), replicando exactamente la query que usa
  `handleChequesCron` con el filtro ya corregido.
- Se confirmó que `demo_reset_periodico` (pg_cron, cada 6hs) corre
  `fn_reset_demo_cron`, que ya encadena `fn_redistribuir_fechas_demo` →
  `fn_rodar_lotes_trigger_demo` → `fn_rodar_cheques_demo` — el rolado de
  cheques queda automático, no requiere intervención manual futura.

## Auditoría de tablas en cero (empresa demo)

Se repasaron las 17 tablas que quedan en cero para la empresa demo: todas
son legítimas — integraciones reales no usadas (AFIP/WSAA, push, pagos),
logs de actividad real que no ocurrió (email, OCR, exportaciones contables),
o una tabla muerta en el código (`ruta_items`, reemplazada por `entregas`).
Ninguna es un hueco de demo. Con este fix, el circuito de rolado de fechas
queda completo: no quedan tablas con datos relevantes ancladas a una fecha
fija del snapshot.

## Lo que sigue sin hacer

- No se probó en vivo contra el cron real (`/api/notif/cheques-por-vencer`)
  con `CRON_SECRET` configurada — la validación fue a nivel de repo/query y
  de la función de Supabase por separado, no del endpoint HTTP completo.
- No hay test de integración que ejercite `handleChequesCron` de punta a
  punta contra una base real — la cobertura actual es unitaria (mocks) para
  el repo, como el resto del módulo `notif`.
