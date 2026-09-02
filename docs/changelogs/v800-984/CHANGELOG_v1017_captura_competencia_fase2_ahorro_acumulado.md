# v1017 — Captura de competencia, Fase 2 (Capa 3 — retención): ahorro acumulado por cliente (2026-08-30)

## Por qué

Fase 1 (v1012-v1013) resolvió la conversión de una foto de factura de
competencia en cliente + pedido, con margen protegido. Lo que quedaba
pendiente era la retención: una vez que ese cliente se queda comprando,
no había forma de mostrarle (ni de que el dueño viera agregado) cuánto le
convino el cambio. Fase 2 cierra ese loop con un contador de ahorro
acumulado por cliente, calculado pedido a pedido contra el precio de
competencia que quedó congelado en su captura de origen.

## Supabase — migración `555_cliente_ahorro_acumulado.sql`

- Tablas nuevas `cliente_ahorro_acumulado` (1 fila por cliente, acumulado
  vigente) y `ahorro_competencia_movimientos` (historial por pedido,
  `UNIQUE(pedido_id)` para idempotencia).
- RPC atómica `fn_registrar_ahorro_competencia`: único camino de
  escritura — insert del movimiento + upsert del acumulado en la misma
  transacción, evitando desde el diseño el bug de doble inserción que
  tuvo en su momento el módulo de puntos (`acreditarPuntos`).
- RLS con aislamiento por cliente (`auth.uid()` envuelto en subquery)
  desde el día uno — aplicando de entrada los dos fixes de
  seguridad/performance que fidelización tuvo que parchear después
  (migraciones 296 y 403).
- De paso, migración `556_captura_competencia_convertido_at.sql`
  (backfill de un pendiente de Fase 1, plan 1.7: la columna
  `convertido_at` nunca se había aplicado en producción con ese
  contenido/número — se renumeró para no chocar con lo ya desplegado).

## Backend

- `lib/repos/captura-competencia.js`: `obtenerPreciosReferenciaCompetencia`
  (precio de competencia congelado por producto, tomando la captura
  convertida más antigua del cliente — no la última), `registrarAhorroCompetenciaRpc`,
  `obtenerAhorroAcumuladoCliente`, `listarAhorroAcumuladoEmpresa`.
- `lib/handlers/pedidos/notificaciones.js`: `acreditarAhorroCompetencia`
  — mismo criterio que `acreditarPuntos` (efecto secundario best-effort,
  no bloquea el pedido si falla). Por cada ítem del pedido, si hay
  referencia de competencia y el precio propio es menor, suma la
  diferencia; si el precio propio subió por encima de la referencia, ese
  ítem no resta — el acumulado nunca retrocede.
- Cableado en los mismos 4 puntos que dispara `acreditarPuntos`:
  `crear-pedido.js`, `confirmar-pedido.js`, el listener
  `pedido_creado.js`, y los re-exports de `pedidos/index.js` y del
  facade `pedidos.js`.
- `lib/handlers/captura-competencia.js`: nueva acción
  `accion=ahorro_ranking` (reporte admin, plan 2.5) — restringida a
  roles no-vendedor porque es un agregado de toda la empresa, no de
  "mis propias capturas".

## Frontend

- `frontend/cliente/cuenta.html`: tarjeta "Ahorraste $X desde que estás
  con nosotros", condicional (solo si hay acumulado > 0), con nota
  aclaratoria de que el precio de referencia está congelado (no se
  compara en tiempo real contra el proveedor anterior).
- `frontend/admin/captura-competencia.html` + `js/captura-competencia.js`:
  sección "Ahorro acumulado por cliente" (ranking + total generado),
  oculta automáticamente sin error visible para el rol vendedor.

## Tests

- `tests/repos/captura-competencia-ahorro.test.js`: las 4 funciones de
  repo nuevas — foco en que `obtenerPreciosReferenciaCompetencia` tome
  la captura convertida más antigua, ignore items descartados/sin match,
  y no pise un producto repetido dentro de la misma captura.
- `tests/handlers/pedidos-ahorro-competencia.test.js`: `acreditarAhorroCompetencia`
  — la regla de "nunca resta", los early-returns, y que el RPC se llama
  con el ahorro total y el detalle correctos.
- `tests/handlers/captura-competencia-ahorro-ranking.test.js`: permisos
  del endpoint (vendedor → 403 aunque `puede()` conceda) y forma de la
  respuesta.
- Suite completa verificada: 84 archivos / 1301 tests, sin regresiones
  (se agregó `listarAhorroAcumuladoEmpresa` al mock del repo en los dos
  tests existentes que mockeaban el módulo entero).

## Pendiente

- Confirmar si conviene un teaser del ahorro también en
  `frontend/cliente/inicio.html` (hoy solo está en `cuenta.html`) — no
  se tocó en esta entrega, a la espera de esa definición.
