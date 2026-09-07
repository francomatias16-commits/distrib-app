# Verificación funcional en vivo — Fase A y Fase D del plan de operación total por voz

**2026-09-06** — Sin cambios de código. Se cerró el único pendiente real que
quedaba del `PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md`: la prueba funcional
contra datos reales de las RPCs cableadas en Fase A y Fase D, que en sesiones
anteriores no se podía correr por falta de credenciales de Supabase en el
entorno. En esta sesión hubo acceso real vía Supabase MCP.

Todas las pruebas se corrieron dentro de transacciones con `ROLLBACK`
explícito contra la base de producción (`jgiquzjwoedmzwqgzubr`) — ningún dato
real quedó modificado.

## Resultados

- **`registrar_cobro_completo`** (Fase A, ítem 1): cobro de $1.500 en efectivo
  sobre cliente real → `{ok:true, cobro_id, nro:"00000001"}`. OK.
- **Alta y edición de producto** (Fase A, ítem 2): insert de producto +
  fila de stock inicial; luego `UPDATE` de precio_base/costo/stock_mínimo
  sobre un producto real (Aceite en caja 12x900cc). Ambas OK.
- **`ajustar_stock`** (Fase A, ítem 4): delta +10 sobre depósito real →
  `{ok:true, stock_nuevo:10, delta:10}`. OK. Nota: el tipo de movimiento
  correcto es `'ajuste'` (no `'ajuste_manual'` como se supuso al armar el
  primer intento) — confirmado contra el enum real `tipo_movimiento` en
  Supabase.
- **`registrar_conteo_stock`** (Fase A, ítem 4): conteo físico de 25 →
  `{ok:true, stock_nuevo:25, diferencia:25}`. OK.
- **`crear_orden_compra` → `recepcionar_orden_compra`** (Fase A, ítem 4):
  flujo completo en una sola transacción — OC de 20 unidades a $550 c/u,
  recepcionada íntegra → `{ok:true, estado_oc:"recibida", total_recibido:13310}`.
  $13.310 = 20×$550×1.21, coherente con el fix de IVA acumulado de la
  migración 453 (ver `CHANGELOG` de esa migración). OK.
- **`consultar_ofertas_liquidacion_asistente`** (Fase D): lectura real,
  0 ofertas activas hoy para la empresa de prueba.
- **`consultar_reglas_liquidacion_asistente`** (Fase D): lectura real de
  `reglas_liquidacion` — reglas vigentes devueltas correctamente.
- **`generar_ofertas_liquidacion_asistente`** (Fase D): corrida en
  `p_dry_run:true` y en modo real (con `ROLLBACK`) — ambas devuelven
  `{ok:true, creadas:[], desactivadas:0}`, coherente con que no hay lotes
  dentro de la ventana de alerta configurada hoy para esa empresa.
- **`guardar_reglas_liquidacion_asistente`** (Fase D): `UPDATE` de prueba
  sobre `reglas_liquidacion` (pct_nivel3 → 30), con `ROLLBACK`. OK.

## Estado del plan tras esto

En `PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md`, §6:
- Verificación a nivel RPC/base de datos de las 5 piezas de Fase A y D:
  **cerrada** (nuevo ítem `[x]` agregado, distinguiéndola del pendiente de
  abajo).
- Quedan sin cerrar (genuinamente, no verificables desde este entorno):
  prueba con dictado real por voz contra el frontend desplegado, sesión
  end-to-end completa por fase, y datos de uso real acumulado. Estos tres
  requieren uso real de la app en producción, no acceso a Supabase.

Actualizadas las notas de §2 y §5 (Fase A ítems 1/2/4, Fase D) en ambas
copias del plan (`/PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md` y
`/docs/planes/PLAN_ASISTENTE_OPERACION_TOTAL_POR_VOZ.md`).
