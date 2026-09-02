# CHANGELOG v200b — Smoke test contra Supabase real + 2 fixes

Continúa v200 (gaps 2/3/4: ventas POS, comprobantes históricos, direcciones).
Se hizo un smoke test contra el proyecto Supabase real (`jgiquzjwoedmzwqgzubr`,
empresa demo "Distribuidora Demo Test SRL") de los 4 gaps del changelog
original, insertando/actualizando/limpiando datos de prueba en cada tabla
involucrada. Aparecieron 2 bugs reales, ya corregidos:

## Bug 1 — `sku` no existe en `productos` (columna real: `codigo`)

El código nuevo de precios especiales (v199) usaba `sku` en varios lugares,
pero la tabla `productos` nunca tuvo esa columna — el resto del proyecto
(`compras.js`, etc.) siempre usó `codigo`. Corregido en:

- `lib/repos/clientes.js` (líneas 59, 78 — embed de `productos` y filtro
  de búsqueda)
- `frontend/admin/js/clientes.js` (líneas 769, 790, 804, 809 — render,
  filtro y selector de productos en el modal de precios)

Verificado con `SELECT column_name FROM information_schema.columns WHERE
table_name = 'productos'` y con el join real
(`precios_clientes JOIN productos`) que ahora devuelve `codigo` sin error.

## Bug 2 — Orden de operaciones en `cliente_direcciones.es_principal`

Existe un **índice único parcial** en DB —
`idx_cliente_direcciones_principal_unica ON cliente_direcciones(cliente_id)
WHERE es_principal` — que garantiza a nivel base de datos una sola
dirección principal por cliente. No es un constraint declarado (no aparece
en `pg_constraint`, solo en `pg_indexes`), así que no se detectó en el
primer chequeo de constraints antes de escribir `cliente-direcciones.js`.

Es una restricción **inmediata** (no diferible): si `crearDireccion` o
`actualizarDireccion` intentan insertar/actualizar una fila con
`es_principal=true` mientras ya existe otra para el mismo cliente, el
INSERT/UPDATE mismo choca contra el índice — sin importar que después se
fuera a desmarcar la otra.

Corregido invirtiendo el orden en `lib/repos/cliente-direcciones.js`:
- `crearDireccion`: ahora despriorizar (`despriorizarOtras`) ocurre
  **antes** del INSERT, no después.
- `actualizarDireccion`: cuando `es_principal === true`, primero se
  obtiene el `cliente_id` de la fila (SELECT), se despriorizan las demás,
  y recién entonces se aplica el UPDATE.
- Comentario de cabecera del archivo corregido (afirmaba erróneamente que
  no había protección a nivel DB).

## Validado en esta sesión (contra la empresa demo, con limpieza posterior)

- **Gap 1** (`precios_clientes`): upsert con conflicto, join con
  `clientes`/`productos` usando `codigo` ya corregido.
- **Gap 2** (`ventas_pos` / historial POS): join con `cajas_pos` +
  `clientes`, filtro de rango `desde`/`hasta` sobre `created_at`.
- **Gap 3** (`comprobantes_historicos`): tabla confirmada vacía en
  producción (se llena solo vía wizard de migración); se insertó una fila
  de prueba para validar el join con `clientes` y los filtros `tipo` +
  rango de fecha, luego se eliminó.
- **Gap 4** (`cliente_direcciones`): insert y update de dirección
  principal con el orden ya corregido (una sola principal verificada por
  query final), constraint de dedupe (`UNIQUE empresa_id, cliente_id,
  domicilio`) disparando 23505 como se espera, join con `clientes` para
  la vista global.

Todos los registros de prueba (`notas`/`observaciones LIKE 'test smoke%'`)
fueron eliminados al finalizar cada validación — no queda data de prueba
en la empresa demo.

## Verificado
- `node --check` en los 3 archivos tocados en esta sesión
  (`lib/repos/clientes.js`, `frontend/admin/js/clientes.js`,
  `lib/repos/cliente-direcciones.js`).
