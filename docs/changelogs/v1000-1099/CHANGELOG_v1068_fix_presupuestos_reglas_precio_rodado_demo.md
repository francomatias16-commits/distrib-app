# v1068 — Fix: presupuestos y reglas_precio quedaban con fecha fija en la demo

Continuación de la auditoría de "circuito de tablas" (v1067, cheques).
Se repitió la auditoría completa: todas las tablas con `empresa_id` +
columna de fecha, comparadas contra la fecha real de hoy. Aparecieron dos
huecos más del mismo patrón — tabla no incluida en ningún
`fn_redistribuir_fechas_demo`/`fn_rodar_*_demo`, con una fecha fija del
snapshot que se aleja de "hoy" con el paso de los días reales.

A diferencia de v1067 (cheques), en este caso **no hay bug de aplicación**
— el filtro de negocio en ambos casos es correcto. El problema es 100%
de datos de demo desactualizándose.

## Hueco 1 — `presupuestos`

El único presupuesto de la demo tenía `estado='enviado'` con
`fecha_vencimiento` ya pasada. El cron real `vencer-presupuestos-diario`
(diario, 6am) lo pasaría a `'vencido'`, pero como la demo se restaura
desde `demo_snapshots` cada 6hs (`fn_reset_demo_v2`), volvía a
`'enviado'` con la misma fecha vieja en el próximo reset — nunca se veía
un presupuesto realmente vigente.

- Nueva función `fn_rodar_presupuestos_demo(p_empresa_id)`: para
  presupuestos `estado='enviado'` con `fecha_vencimiento < CURRENT_DATE`,
  re-ancla a "vence en 5 días desde hoy", preservando el plazo original
  entre `created_at` y `fecha_vencimiento`.

## Hueco 2 — `reglas_precio`

`resolver_precios_cliente`/`resolver_precios_etiquetas` exigen
`fecha_hasta >= CURRENT_DATE` para aplicar una regla. La regla
*"Limpieza 15% Zona Norte - fin de mes"* (`activa=true`) tenía
`fecha_hasta` ya pasada — nunca volvía a aplicar sola, contradiciendo su
propio nombre ("fin de mes" implica vigente).

- Nueva función `fn_rodar_reglas_precio_demo(p_empresa_id)`: para reglas
  `activa=true` con `fecha_hasta < CURRENT_DATE`, re-ancla a "vence en 5
  días desde hoy" preservando la duración original de la ventana
  (`fecha_hasta - fecha_desde`).
- **Excluye a propósito** las reglas cuyo nombre indica que están
  vencidas/pausadas como caso de demo intencional (`nombre ILIKE
  '%finalizad%'`, `'%pausad%'`, `'%vencid%'`) — ej. *"Congelados invierno
  20% (promo finalizada)"* debe seguir mostrando el estado vencido, no
  rodar con el resto. Verificado: quedó intacta tras el fix.

## Wireado

`fn_reset_demo_cron()` ahora invoca ambas funciones nuevas al final,
mismo lugar y mismo criterio que `fn_rodar_lotes_trigger_demo` /
`fn_rodar_cheques_demo` (v1067). Sigue corriendo automático vía
`demo_reset_periodico` (pg_cron, cada 6hs) — no requiere intervención
manual futura.

## Validado en esta sesión

- Se corrieron ambas funciones nuevas manualmente sobre la empresa demo
  y se confirmó el resultado esperado (presupuesto → vence 2026-09-14;
  regla "fin de mes" → fecha_hasta 2026-09-14; regla "finalizada" →
  intacta en 2026-08-14).
- Se corrió `fn_reset_demo_cron()` completo (el mismo que dispara el
  cron cada 6hs) de punta a punta — sin errores — y se confirmó que
  presupuestos, reglas_precio, cheques y lotes quedan todos dentro de sus
  ventanas correctas después de un ciclo completo de reset.
- No hubo cambios de código de aplicación en este fix — es exclusivamente
  del lado de los datos de demo en Supabase.

## Auditoría de tablas con fecha (empresa_id + columna date/timestamp)

Se relevaron ~130 tablas. Fuera de los dos huecos de arriba, todo lo demás
cae en alguno de estos casos esperados:
- Tablas de archivo/histórico por diseño (`notif_log_historico`,
  `eventos_negocio_historico`, `comprobantes_historicos`) — no deben
  rodar, son retención de datos viejos a propósito.
- Filas dentro del spread normal de hasta 216 días que ya cubre
  `fn_redistribuir_fechas_demo` (algo lejos de "hoy" ahí es esperado, no
  un bug).
- Configuración estática que no depende de estar "al día" (reglas de
  automatización, etiquetas, config de facturación, programas de
  fidelización, etc.).

Con esto, el circuito de rolado de fechas de la demo queda completo: no
quedan tablas con datos de negocio relevantes ancladas a una fecha fija
del snapshot original.
