# v588 — Fase 7, paso 9, sub-lote 4: núcleo transaccional de `pos.js` — paso 9 CERRADO

Continuación de los sub-lotes 1-3 de `pos.js` (catálogo/stock, config
varios, caja/turno — ver cabecera de `lib/repos/pos.js`). Último bloque
pendiente: el núcleo transaccional — venta, anulación, facturación,
ticket, listado de ventas y devoluciones. El más sensible del módulo,
porque toca stock, pagos y facturación AFIP en la misma operación.

## Qué se hizo

**12 funciones nuevas en `lib/repos/pos.js`**, más el re-export de
`resolverPreciosClienteRpc` (ya existía en `lib/repos/whatsapp-bot.js`,
mismo RPC que usa el flujo de pedidos del portal/admin — se reusa en vez
de duplicar, mismo criterio que `pedidos.js`):

- `obtenerUmbralDescuentoUsuario`, `obtenerCajaParaVenta`,
  `obtenerClienteActivoParaVenta`, `registrarVentaPosRpc` —
  `registrarVentaHandler`. Reuso de `obtenerDepositoPrincipal` y
  `asignarDepositoACaja` (ya existían del sub-lote 1) para el fallback de
  depósito automático cuando la caja no tiene uno asignado.
- `obtenerVentaParaAnular`, `anularVentaPosRpc` — `anularVentaHandler`.
- `obtenerVentaParaFacturar` — `facturarVentaHandler`.
- `obtenerVentaParaTicket` — `ticketHandler`.
- `listarVentasPos` — `ventasHandler` (listado paginado con filtros
  dinámicos: `q`, `estado`, `desde`, `hasta`).
- `listarDevolucionesDeVenta` — `getDevolucionesHandler`.
- `obtenerVentaParaDevolucion`, `registrarDevolucionPosRpc` —
  `devolucionHandler`.

**Sin cambios de comportamiento.** Se replicó tal cual la política de
error de cada query original (silenciosa vs. propagada) — por ejemplo,
`obtenerVentaParaAnular`/`obtenerVentaParaFacturar`/
`obtenerVentaParaDevolucion` ignoran el error igual que el handler
original (`const { data } = await ...`), mientras que
`obtenerVentaParaTicket` y `listarVentasPos` lo propagan porque el
handler original hacía `if (error) return errorSeguro(...)`.

Un detalle preservado a propósito: en `registrarVentaHandler`, la
consulta de umbral de descuento (`usuarios`) y la de PIN de supervisor
(`empresas`) corrían en paralelo vía `Promise.all`. Se mantiene el
paralelismo llamando a `obtenerUmbralDescuentoUsuario` (nueva) y
`obtenerPinSupervisor` (ya existía del sub-lote 3, reusada acá) dentro
del mismo `Promise.all`.

## Verificación

- `grep -c "\.from(\|\.rpc(" lib/handlers/pos.js`: 1 (el lookup de
  `perfil` en el router de auth — identidad, no dato de negocio, fuera de
  alcance de Fase 7 desde el inicio, mismo criterio que la excepción de
  `db.auth.admin.*` en `clientes.js`).
- Tests nuevos: `tests/repos/pos.test.js` (18 casos — no existía
  cobertura de repo para `pos.js` en ningún sub-lote anterior). Foco en
  aislamiento por `empresa_id` (que ninguna función devuelva/edite una
  venta, caja o cliente de otra empresa) y en que las RPCs de
  venta/anulación/devolución pasen los parámetros correctos sin alterar
  el contrato original (`p_motivo: null` cuando viene vacío, `p_items`
  serializado a JSON).
- Suite completa: **689/689 OK** (671 previos + 18 nuevos).

## Paso 9 completo

`lib/handlers/pos.js` migró sus accesos a datos a `lib/repos/pos.js` en 4
sub-lotes, sin cambiar comportamiento observable en ningún paso. El repo
suma 66 funciones exportadas en total. Con esto se cierran los pasos 8
(`pedidos.js`) y 9 (`pos.js`) del plan — los dos módulos que se dejaron
para el final por ser el corazón transaccional del sistema (ver `## 1.
Orden de migración propuesto`, punto 6, en `FASE7_PLAN_ARRANQUE.md`).

Pendiente para más adelante, igual que quedó anotado para `pedidos.js`:
sumar tests dedicados a los sub-lotes 1-3 de `pos.js` (catálogo/stock,
config varios, caja/turno) — hoy sin cobertura de repo propia, cubiertos
solo indirectamente por la suite existente.
