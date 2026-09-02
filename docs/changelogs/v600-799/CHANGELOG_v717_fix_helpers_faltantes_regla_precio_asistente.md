# v717 — Fix: helpers faltantes de `crear_regla_precio_asistente`/`editar_regla_precio_asistente`

## Contexto

Hallazgo anotado como pendiente al cierre de v716 (Fase D, liquidación):
`crear_regla_precio_asistente` y `editar_regla_precio_asistente` (Fase B,
dadas por ✅ cerradas) llamaban a `armarCamposReglaPrecio`,
`describirReglaPrecio` y `armarCambiosReglaPrecio` — tres funciones que
nunca se escribieron. Cualquier intento de crear o editar una regla de
precio por voz tiraba `ReferenceError` apenas el modelo elegía la tool.

## Cambios (`lib/asistente-tools.js`)

Se escribieron los 3 helpers faltantes, calcados 1 a 1 del patrón que ya
usa `reglas_automatizacion` (`armarCamposReglaAutomatizacion` /
`describirReglaAutomatizacion` / `armarCambiosReglaAutomatizacion`),
adaptados a los campos reales de `reglas_precio`:

- **`armarCamposReglaPrecio({ empresaId, args })`**: valida nombre,
  `tipo_descuento` (`porcentaje`/`precio_fijo`), `valor` (0-100 si es
  porcentaje), y que no vengan producto Y categoría a la vez — mismas
  reglas que `validarCampos()` del repo (`lib/repos/reglas-precio.js`),
  replicadas acá para poder devolver un error claro antes de tocar la
  base. Resuelve producto/categoría/zona por texto libre (nunca por id)
  con los resolvers ya existentes (`buscarProductoPorTexto`,
  `buscarCategoriaPorTexto`, `buscarZonaPorTexto`) y lleva los nombres
  resueltos en el mismo objeto (`productoNombre`, `categoriaNombre`,
  `zonaNombre`) solo para que `describirReglaPrecio()` los use —
  `crearReglaPrecio()` destructura explícito lo que le sirve e ignora el
  resto, así que esos campos de más no rompen nada.
- **`describirReglaPrecio(campos)`**: arma la frase de `resumen()` (lo
  único que ve el usuario antes de Confirmar) — descuento, cantidad
  mínima, alcance (producto/categoría/todos), zona y vigencia si
  corresponde.
- **`armarCambiosReglaPrecio({ empresaId, args })`**: igual criterio que
  `armarCambiosReglaAutomatizacion` — `actualizarReglaPrecio()` valida
  nombre/tipo_descuento/valor como si fuera una creación aunque el patch
  real a la base solo escriba las claves presentes en el objeto, así que
  no alcanza con mandar un patch parcial. Trae la fila actual completa de
  `reglas_precio` y pisa encima solo los campos que el usuario pidió
  cambiar (incluye el mismo chequeo de producto/categoría mutuamente
  excluyentes, y las mismas validaciones de rango/vigencia que la
  creación).

## Pendiente

- Prueba funcional contra datos reales (sin credenciales de Supabase en
  este entorno) — mismo estado que el resto de las tools de Fase A/B/D.
- Con este fix, las 4 tools de reglas de precio y automatización
  (`crear`/`editar` × precio/automatización) quedan todas operativas.
