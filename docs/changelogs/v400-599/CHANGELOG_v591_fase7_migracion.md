# v591 — Fase 7, paso siguiente a `pos.js`: `migracion.js` — CERRADO

Con `pedidos.js` y `pos.js` (los dos módulos transaccionales más grandes)
ya cerrados, se encara `migracion.js` — el handler con más volumen de
`.from()` directo sin pasar por repo (56, el más alto de la tabla de
pendientes de Fase 7).

## Qué se hizo

**`lib/repos/migracion.js` (nuevo)** — 24 funciones, cubre
`migracion_sesiones`, `migracion_staging_rows` y
`migracion_plantillas_mapeo`:

- Plantillas de mapeo: `listarPlantillasMapeo`, `crearPlantillaMapeo`,
  `borrarPlantillaMapeo`.
- Sesiones: `obtenerSesionPorId`, `listarSesionesPorEmpresa`,
  `obtenerUltimaSesion`, `buscarSesionesDuplicadas`,
  `obtenerSesionOrigenEntreIds`, `crearSesion`, `actualizarSesion`,
  `obtenerResumenAdvertenciasSesion`.
- Filas de staging: `insertarFilasStaging`, `contarFilasStaging`,
  `obtenerFilasSesion`, `obtenerFilasPorEntidadResultado`,
  `obtenerLoteSinMapear`, `obtenerDatosMapeadosDeSesion`,
  `obtenerFilasParaResumen`, `resetearMapeoSesion`, `obtenerFilaPorId`,
  `actualizarAccionFila`, `obtenerProgresoConfirmacion`,
  `obtenerProgresoDeshacer`, `reabrirFilasFallidas`.

**`lib/repos/proveedores.js` (nuevo, arranque mínimo)** —
`listarProveedoresParaDedupePorEmpresa`, unifica 3 llamadas idénticas que
había repetidas en las funciones `mapearSesionX`. Todavía no hay handler
`proveedores.js` migrado; este repo por ahora solo tiene lo que necesitaba
`migracion.js`.

**`lib/repos/clientes.js`** — se agregó `listarCuitClientesPorEmpresa`
(unifica 8 llamadas idénticas de `sb.from('clientes').select('id, cuit')`
repetidas en las `mapearSesionX`).

**`lib/repos/pos.js`** — se agregaron 4 funciones para el selector de
depósito/lista de precios destino al mapear una sesión de `productos` o
`lotes`: `listarDepositosParaSelector`, `listarListasPrecioParaSelector`,
`obtenerListaPrecioPorId`, `obtenerListaPrecioDefault`. (`obtenerDepositoPorId`
y `obtenerDepositoPrincipal` ya existían en `lib/repos/pedidos.js` — se
reusan en vez de duplicar.)

**`lib/repos/index.js`** — se agregaron `MigracionRepo` y `ProveedoresRepo`
al barrel.

**`lib/handlers/migracion.js`** — los 56 `.from()`/`.rpc()` directos
originales pasan por los repos de arriba, sin cambio de comportamiento
observable: se replicó tal cual la política de error de cada query
(silenciosa vs. propagada) — por ejemplo `obtenerSesionPorId` y
`obtenerResumenAdvertenciasSesion` ignoran el error igual que el original,
mientras que `insertarFilasStaging`, `resetearMapeoSesion` y
`actualizarAccionFila` lo devuelven porque el original hacía throw/chequeo
explícito. El caso genérico de `mapearSesionMaestro` (dedupe contra la
tabla dinámica de la entidad, antes `sb.from(tablaEntidad)`) se resolvió
así: cuando la tabla dinámica solo puede ser `clientes` o `productos` (las
demás entidades ya delegaban a un flujo dedicado) se usan los repos
existentes; el `.from(tabla)` genérico de `mapearSesionMaestro` en sí
queda como acceso directo, documentado en comentario, porque alterna
genuinamente entre 4 tablas y 2 de ellas (`categorias`, `zonas`) todavía
no tienen repo propio.

Quedan sin migrar, a propósito y documentado en comentarios:

- Los 31 `.rpc('migracion_*', ...)` — encapsulan lógica del lado de la
  base (bulk de mapeo, confirmación/deshecho por lote, precheck de
  advertencias), mismo criterio que `cta_cte.js`.
- 2 `.from('audit_log').insert(...)` — no hay repo de auditoría todavía;
  el mismo insert se repite en otros handlers, mejor unificarlo una sola
  vez cuando se aborde ese módulo.
- 1 `.from(tabla)` dinámico en `mapearSesionMaestro`, por lo explicado
  arriba.

## Verificación

- `grep -c "sb\.from\|sb\.rpc" lib/handlers/migracion.js`: 33 (31 `.rpc()`
  + 2 `.from('audit_log')`, ambos dejados a propósito). Confirmado también
  que no queda ningún `.from()`/`.rpc()` sin prefijo `sb` (solo el
  comentario que menciona `.from()` y el `.from(tabla)` dinámico
  documentado).
- Sintaxis válida (`node --check`) en todos los archivos tocados.
- Tests nuevos: `tests/repos/migracion.test.js` (24 casos — no existía
  cobertura de repo para `migracion.js`). Foco en aislamiento por
  `empresa_id`/`sesion_id` y en que las funciones de escritura no se
  traguen errores en silencio donde el handler original no lo hacía
  (`insertarFilasStaging`, `obtenerLoteSinMapear` — esta última con
  throw, a diferencia del resto de las lecturas del repo, que son
  silenciosas igual que el original).
- Suite completa: **713/713 OK** (95 de `migracion`/`clientes`/`pos`/
  `productos` + 618 del resto, sin roturas).

## Paso completo

`lib/handlers/migracion.js` migró sus accesos a datos a
`lib/repos/migracion.js` (nuevo), `lib/repos/proveedores.js` (nuevo,
arranque mínimo) y ampliaciones a `lib/repos/clientes.js` y
`lib/repos/pos.js`, sin cambiar comportamiento observable. Con esto se
cierran 9 módulos de Fase 7: `clientes`, `empresas`, `productos`,
`cta_cte`, `stock`, `notif`, `pedidos`, `pos`, `migracion`.

Pendiente para más adelante:

- El handler completo de `proveedores.js` (32 `.from()` directos, ahora el
  de mayor volumen en la tabla de pendientes) — hoy solo tiene la función
  mínima que necesitaba `migracion.js`.
- Un repo de auditoría (`audit_log`) para unificar los inserts que hoy se
  repiten sueltos en varios handlers, incluido `migracion.js`.
- Repos propios para `categorias` y `zonas`, para poder terminar de
  eliminar el `.from(tabla)` dinámico que queda en `mapearSesionMaestro`.
