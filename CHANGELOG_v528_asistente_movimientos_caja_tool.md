# v528 — Nueva tool `listar_movimientos_caja` (sin conectar al asistente)

## Reportado

Continuando la revisión del catálogo de tools del asistente contra las
tablas centrales del sistema (mismo criterio que v526/v527), se detectó
que `movimientos_caja` (sangrías, refuerzos y retiros finales de caja
del POS) se usa activamente en la operación de caja pero el asistente
no tenía ninguna forma de consultarla. Ante una pregunta como "cuánto
se sacó de caja esta semana" o "hubo refuerzos hoy", no había tool que
devolviera ese dato.

## Diagnóstico

Igual que `ordenes_compra` (v527) y a diferencia de `movimientos_stock`
(v526), `movimientos_caja` **sí** tiene `empresa_id` propio, así que el
scope es directo sin necesidad de join intermedio a `turnos_caja`. Se
verificó el schema real contra la base antes de escribir la migración:
`tipo` está restringido por constraint a `sangria` / `refuerzo` /
`retiro_final`, `monto` exige ser positivo, y `usuario_id` referencia
`usuarios(id)` directamente (no hace falta pasar por `turnos_caja` para
resolver el nombre del empleado — `usuarios.nombre` está disponible con
un join directo).

Nota operativa: al momento de esta migración la tabla `movimientos_caja`
está vacía en producción (0 filas en cualquier empresa) — el módulo de
caja/POS aún no tiene uso real registrado. La prueba funcional se hizo
con 3 filas insertadas temporalmente en el tenant demo (Distribuidora
del Litoral S.A.) y borradas inmediatamente después de validar.

## Cambios

### `supabase/migrations/425_asistente_movimientos_caja.sql`

- Nueva RPC `listar_movimientos_caja(p_empresa_id, p_tipo, p_usuario, p_dias)`:
  - `SECURITY DEFINER`, `STABLE`, `search_path` fijado a `public`.
  - Scopeada directo por `movimientos_caja.empresa_id` (sin join
    intermedio, mismo criterio que v527).
  - Filtros opcionales por tipo exacto (`sangria` / `refuerzo` /
    `retiro_final`) y por nombre de usuario (`ILIKE` sobre
    `usuarios.nombre`, join `LEFT` para no perder filas si el usuario
    fue borrado).
  - Ventana de días configurable (`p_dias`, default 30 al nivel de la
    tool, tope 180).
  - Devuelve totales acumulados por tipo (`total_sangrias`,
    `total_refuerzos`, `total_retiros_finales`) sobre **todo** el
    período filtrado, no solo sobre las filas mostradas — mismo
    criterio usado en otras tools de resumen del asistente.
  - Cap de 20 filas mostradas (`movimientos_mostrados`), pero
    `total_movimientos` devuelve el conteo real sin cap.
  - Grants: `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO service_role`,
    con el `REVOKE` explícito de `anon`/`authenticated` incluido **en
    la misma migración** (mismo criterio que v527, sin fix aparte).

### `lib/asistente-tools.js`

- Nueva tool `listar_movimientos_caja`, ubicada junto al cluster de
  tools de proveedores/compras (después de `listar_ordenes_compra`).
  - `roles: ['dueno', 'admin']` — a diferencia de `listar_ordenes_compra`
    (que incluye `depositero`), esta tool queda restringida a dueño y
    admin porque expone qué empleado retiró qué monto de caja,
    información sensible sobre el manejo de dinero de otros usuarios
    (mismo criterio que `consultar_anomalias_auditoria`).
  - Parámetros opcionales: `tipo` (sangria / refuerzo / retiro_final),
    `usuario` (texto libre), `dias` (default 30, tope 180 desde la
    tool).
  - `execute()` llama directo a la RPC `listar_movimientos_caja` vía
    `db.rpc(...)`.

## Verificación

Migración 425 aplicada contra el proyecto de producción
(`jgiquzjwoedmzwqgzubr`). Se confirmó:

- La función existe con la firma esperada y solo `service_role` tiene
  `EXECUTE` (`anon`/`authenticated` sin acceso, confirmado en la misma
  migración sin necesidad de fix posterior).
- Sintaxis de `lib/asistente-tools.js` verificada con `node --check`.
- Prueba funcional: se insertaron 3 movimientos de prueba (1 sangría,
  1 refuerzo, 1 retiro_final) en el tenant demo, ligados a un turno y
  usuario reales (Marina Torres). La RPC devolvió las 3 filas con el
  nombre de usuario resuelto correctamente y los totales por tipo
  exactos (`total_sangrias: 15000`, `total_refuerzos: 5000`,
  `total_retiros_finales: 32000`).
- Prueba de filtro por tipo: `tipo='sangria'` devolvió 1 de 3 filas,
  con `total_sangrias` correcto y los otros dos totales en 0.
- Filas de prueba borradas inmediatamente después de validar (no queda
  data sintética en producción).

## Cómo queda

El asistente ahora puede responder consultas sobre el historial de
movimientos de caja (sangrías, refuerzos, retiros finales), filtrando
por tipo y/o usuario, con totales acumulados por tipo y aclarando
cuando hay más movimientos de los que se muestran (`total_movimientos`
vs `movimientos_mostrados`). Al no haber datos reales aún en
producción, el asistente devolverá listas vacías hasta que el módulo
de caja empiece a usarse.

## Archivos modificados

- `supabase/migrations/425_asistente_movimientos_caja.sql` (nuevo)
- `lib/asistente-tools.js`
