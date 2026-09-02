# v1049 — Etapa 7 (Bloque 1, Devoluciones): fix caso borde devolución + NC + factura

## Contexto

Retomando el pendiente explícito de v1048 ("casos borde de devolución sobre
pedido con NC previa desde el ángulo de facturación/ARCA"). El caso real
resultó más grave que un caso borde de "NC previa": es un bug estructural en
**cualquier** Nota de Crédito que nazca de una devolución parcial, apenas se
la intenta emitir contra ARCA — no hacía falta una segunda devolución para
disparrarlo.

## Hallazgo (🔴 crítico) — toda NC parcial se emitía por el total completo de la factura, y anulaba la factura entera

Cadena del bug:

1. `crearDevolucionCore` (con `generar_nc: true`) arma la NC con
   `crear_nota_credito` usando solo los ítems devueltos — si un pedido
   facturado tenía 5 productos y el cliente devuelve 1, la NC queda
   correctamente en `notas_credito` con el monto de ese 1 ítem.
2. Al emitirla desde el panel (`POST .../notas-credito?accion=emitir`),
   `emitirNotaCreditoARCA` (`lib/arca/wsfev1.js`) **ignoraba por completo el
   monto real de la NC**: pedía el CAE por `facturaOrig.total` (el total de
   la factura *completa*) y `persistir_nc_y_anular_factura` marcaba la
   factura entera como `estado = 'anulada'`, sin excepción.

Resultado con el ejemplo de arriba: la NC que veía el admin decía, por
ejemplo, $2.000 (1 de 5 productos) — pero al emitirla, ARCA autorizaba (y
quedaba declarado) una Nota de Crédito por el total de la factura completa
($10.000), y la factura quedaba anulada al 100% aunque el cliente se quedó
con los otros 4 productos. `notas_credito.total` y lo efectivamente
declarado a ARCA quedaban desalineados.

Consecuencia encadenada (el caso "NC previa" original): una vez anulada la
factura, `obtenerFacturaRecienteDePedido` (que solo busca en estado
`emitida`/`pagada`) dejaba de encontrarla — una segunda devolución sobre el
mismo pedido generaba una NC sin factura vinculada (`factura_id: null`),
flotando sin comprobante asociado.

No había ningún test que ejercitara este camino — `tests/e2e/specs/admin/
devoluciones.spec.js` mockea la emisión ARCA por completo.

## Fix

Esta integración no sabe construir una Nota de Crédito **parcial** contra
ARCA (requeriría reconstruir el desglose de IVA solo de los ítems devueltos
y no tocar el estado de la factura — no implementado). Hasta que eso exista:

- `lib/handlers/facturas.js` (`accion=emitir`): si la NC está vinculada a una
  factura y su `total` es menor al total de esa factura (NC parcial), **ya
  no se llama a `emitirNotaCreditoARCA`**. Se aplica el crédito directo en
  `cta_cte` (mismo mecanismo que el modo manual sin config ARCA) por el
  monto correcto, sin anular la factura original, y se deja registrado en
  `notas_error` que hay que declararla a mano en el portal de AFIP/ARCA por
  ese monto. La factura sigue `emitida`/`pagada` — vigente por el resto no
  devuelto — así que una devolución posterior sobre el mismo pedido la
  vuelve a encontrar sin problema.
- `lib/repos/facturas.js` (`obtenerNotaCreditoParaEmitir`): ahora trae
  `total, estado` de la factura vinculada (antes no venían), necesarios para
  la detección de arriba.
- Migración `572_fix_crear_nota_credito_valida_no_exceder_total_factura`:
  como con el fix anterior la factura ya no se anula automáticamente al
  primer parcial, quedaba abierta la puerta a que **varias** NC parciales
  sobre la misma factura sumaran, entre todas, más de lo facturado —
  ninguna validación lo impedía. `crear_nota_credito` ahora rechaza una NC
  nueva si, sumada a lo ya acreditado (cualquier NC de esa factura con
  estado ≠ `anulada`), supera el total de la factura (tolerancia 0.05).
  Aplicada y verificada en producción (`jgiquzjwoedmzwqgzubr`).

## Test

`tests/handlers/facturas-notas-credito-emitir-parcial.test.js` (nuevo, 3
casos) cubre el comportamiento observable del fix en
`handleNotasCredito`/`accion=emitir`:

1. NC parcial (total < total de la factura vinculada) → `emitirNotaCreditoARCA`
   nunca se llama; se acredita en `cta_cte` con `p_cae: null`; queda
   `notas_error` con el aviso de declarar a mano; responde `modo: 'manual_parcial'`.
2. NC que cubre el total completo de la factura → sigue yendo por ARCA como
   antes (no rompe el camino feliz existente).
3. NC sin factura vinculada (`factura_id: null`) → no se la trata como
   parcial; sigue el modo manual genérico de siempre (`modo: 'manual'`),
   sin el mensaje nuevo de "NC parcial".

Suite completa: **89 archivos / 1350 tests, 0 fallos** (`npx vitest run`) —
los 1347 preexistentes de v1048 más estos 3.

⚠️ No cubre la migración 572 (el tope SQL de "no exceder el total de la
factura entre varias NC parciales") — esa validación vive dentro de
`crear_nota_credito` y necesita un test de integración contra Postgres real
para ejercitarse; mismo gap que ya se venía arrastrando para las RPC de
devoluciones desde v1048.

## Smoke test de integración (post-fix, contra Postgres real)

Corrido a mano contra el proyecto real (`jgiquzjwoedmzwqgzubr`), con datos
de prueba (`empresas.nombre = 'TEST-SMOKE-V1049'`) creados y borrados en la
misma sesión — no queda ningún resto en la base. Cubre exactamente el gap
de arriba (el tope de la migración 572, no ejercitable desde un test
unitario de JS con mocks):

1. Factura de $10.000 (`estado = 'emitida'`). NC de $2.000 vía
   `crear_nota_credito` → acepta.
2. NC adicional de $8.000 sobre la misma factura (acumulado exacto:
   $10.000) → acepta — confirma que el límite con tolerancia 0.05 no es
   off-by-one en el borde.
3. NC adicional de $1 (acumulado $10.001) → **rechaza**, con el mensaje de
   error esperado (`"...supera el total facturado..."`).
4. Se marca `estado = 'anulada'` en la NC de $8.000 del punto 2, y se
   reintenta una NC de $8.000 → **acepta** — confirma que el `SUM(...)
   WHERE nc.estado <> 'anulada'` de la migración excluye correctamente las
   NC anuladas del cómputo, tal como documenta el comentario de la
   migración.

Con esto, el tope SQL de la migración 572 queda verificado contra Postgres
real en sus tres casos relevantes (límite exacto, exceso, exclusión de
anuladas). Sigue pendiente el pase manual en navegador de la UI (ver
"Pendiente" más abajo) — este smoke test cubre la capa de base de datos,
no el flujo completo desde el panel admin.

## Alcance de lo que NO se resuelve acá

- No se implementó emisión real de Notas de Crédito parciales contra ARCA.
  Mientras tanto, toda devolución parcial con NC queda acreditada en cta_cte
  pero pendiente de declaración manual en AFIP — es una limitación de
  producto, no solo un parche técnico, y alguien de contabilidad tiene que
  saberlo.
- Sigue sin existir un flujo separado de "anular factura completa" vs. "NC
  por devolución parcial" — hoy conviven en el mismo botón/endpoint; el fix
  de esta sesión los diferencia por monto (`nc.total` vs `factura.total`),
  no por una acción explícita del usuario.
- El tope SQL de `crear_nota_credito` (migración 572) ya se verificó con un
  smoke test manual contra Postgres real (ver sección arriba), pero sigue
  sin existir como test automatizado (pgTAP o script en CI) — hoy hay que
  correrlo a mano. Sigue faltando ese mismo tipo de cobertura automatizada
  para el nuevo branch de `handleNotasCredito` end-to-end (JS + DB juntos,
  no solo mockeado).

## Pendiente (sin tocar en esta sesión)

- Pase manual en navegador real de todo el Bloque 1 (sigue pendiente desde
  v1047).
- Decidir si vale la pena construir emisión ARCA de NC parcial real, o si
  el flujo "acreditar en cta_cte + declarar a mano" queda como diseño
  definitivo para este producto.
