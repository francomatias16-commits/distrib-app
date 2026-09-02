# v586 — Fase 7, paso 8, lote 4 (sub-lote 1: notificaciones y puntos)

## Cierre de cabo suelto (lote 1)

`handlePresupuestos` traía el perfil del usuario logueado con una query
cruda a `usuarios` que había quedado afuera del lote 1 (se migró el resto
del handler, pero esta función del repo — `obtenerPerfilChofer` — todavía
no existía cuando se hizo ese lote). Se cierra con una función propia,
`obtenerPerfilPresupuestos`, en vez de reusar `obtenerPerfilChofer`: son
dos concerns con gates de permisos independientes (`presupuestos` vs
`pedidos_chofer`).

## Lote 4, sub-lote 1: notificaciones y puntos

El núcleo de creación/confirmación de pedido (paso 8, "próximo lote" del
plan) es el bloque más grande y sensible de `pedidos.js` — compartido por
9 handlers distintos (creación de pedido, confirmación, reserva de stock
con rollback, puntos, notificaciones). Se partió en sub-lotes; este cubre
la parte más autocontenida: notificaciones (WhatsApp/email/push) y
acreditación de puntos de fidelización. Queda para el sub-lote siguiente
`crearPedidoParaCliente`/`confirmarPedidoHandler` (reserva de stock con
rollback) y el router principal.

**17 funciones nuevas en `lib/repos/pedidos.js`:**
- `obtenerEstadoRuta`, `listarEstadosEntregasDeRuta`, `actualizarEstadoRuta`
  — usadas por `sincronizarEstadoRuta`.
- `obtenerClienteTelefonoRazonSocial` — `notificarEstado` (WhatsApp).
- `obtenerClienteParaEmailDespacho`, `obtenerEmpresaContacto` —
  `notificarDespachoPorEmail`.
- `insertarNotifLog` — `_logNotif` (auditoría de notificaciones).
- `obtenerPedidoNumeroYTotal` — reusada por `notificarPedidoConfirmado` y
  `notificarPushAdmin`.
- `obtenerPedidoCompletoParaEmailConfirmacion`,
  `obtenerClienteEmailRazonSocial` — email de confirmación de pedido.
- `obtenerProgramaFidelizacionActivo`, `obtenerPedidoTotal`,
  `obtenerClienteScoreCategoria` — cálculo de puntos a acreditar (incluye
  bonus por categoría de score).
- `registrarMovimientoPuntosRpc`, `insertarMovimientoPuntosFallback`,
  `sumarSaldoPuntosFallbackRpc` — acreditación atómica de puntos con
  fallback manual si el RPC principal falla.
- `obtenerPerfilPresupuestos` — cierre del cabo suelto de arriba.

**Handler migrado sin cambiar comportamiento observable.** Mismos
fallbacks (WhatsApp independiente del email de confirmación, RPC de
puntos con fallback manual + upsert atómico de saldo), mismo manejo de
errores best-effort, mismos `console.error` de diagnóstico.

**Resultado:** `grep -c "\.from(" lib/handlers/pedidos.js`: 97 → 37 (incluye
también lo ya migrado en los lotes 2 y 3, que no tenían changelog propio
todavía). Quedan los 37 `.from()` del núcleo de creación/confirmación de
pedido.

**Tests:** suite completa **671/671 OK**. Sin casos nuevos en este
sub-lote — el cambio es wiring 1:1 del handler a funciones que siguen el
mismo patrón ya cubierto por `tests/repos/pedidos.test.js`. Se evalúa
sumar tests dedicados junto con el sub-lote de creación de pedido, que es
donde vive la lógica con más ramas (reserva de stock, rollback).
