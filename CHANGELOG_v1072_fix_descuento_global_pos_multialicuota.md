# v1072 — Fix: descuento global POS rompía la facturación A/B con alícuotas mixtas

## Contexto

Continuación de la reconciliación de "Etapa 2/3" del plan de auditoría de flujo:
los tests de `iva-desglose.js` y de concurrencia (`registrar-venta-pos-race`,
`registrar-cobro-completo-race`) resultaron reales y corriendo en CI (144→145
archivos, 2018→2024 tests, `ci.yml` ejecuta `npm test` en cada push). Al
verificar en profundidad el gap angosto que quedaba ("descuento global +
multi-alícuota sin testear"), apareció un bug real y en producción, no solo
falta de cobertura.

## Hallazgo

`lib/handlers/pos.js` aplicaba el `descuento_global_pct` **una sola vez sobre
el total ya sumado** de todos los ítems, en vez de prorratearlo por línea.
Como resultado, `venta_pos_items.subtotal` (lo que queda persistido por
ítem) nunca reflejaba el descuento global.

Esto rompe la facturación A/B: `emitirFactura()` → `wsfev1.js` reconstruye
el desglose de IVA por alícuota leyendo `venta_pos_items` (`calcularDesgloseIva`)
y **corta la emisión** si el resultado no cierra contra `facturas.total`
(tolerancia 0.05). Con descuento global > 0 y más de un ítem, el desvío
puede ser arbitrariamente grande (repro real incluido en los tests: $23.50
de diferencia con un descuento del 10% en un carrito de dos alícuotas).

No es un caso de borde: `pos.js` dispara facturación automática en el
mismo request para **toda venta con un pago a cuenta corriente** — cualquier
distribuidora que le dé descuento a un cliente de cta_cte con catálogo de
alícuotas mixtas (alimentos 10.5% + resto 21%, combinación típica de
distribuidora) lo pisaba.

## Fix

- Nuevo `lib/calc/pos-totales.js`: función pura `calcularTotalesPos()`
  (mismo patrón que `pedido-totales.js`) que prorratea el descuento global
  por ítem, **antes** de calcular el IVA de cada línea, en vez de restarlo
  del total combinado al final.
- `lib/handlers/pos.js` reemplaza el cálculo inline por esta función.
- Sin cambios de contrato: mismo `req.body`, misma forma de `itemsParaRpc`,
  mismo `total` para pagos/facturación automática/cta_cte.

## Límite conocido, documentado pero no resuelto (decisión de negocio pendiente)

`total` se redondea a peso entero (efectivo sin centavos). Esto por sí solo
—independiente del descuento global, y preexistente a este fix— puede
desviar `total` hasta $0.50 de la suma exacta de los ítems, lo cual también
excede la tolerancia de 0.05 de `wsfev1.js`. Antes de este fix el
descuento global sumaba un desvío propio que escalaba con el % aplicado;
ese desvío queda en cero. El remanente de redondeo a peso quedó documentado
en `lib/calc/pos-totales.js` para que CLAY decida: ¿una venta que se va a
facturar A/B debería llevar centavos en `total` igual que la factura, o se
reconcilia de otra forma?

## Tests

- Nuevo `tests/calc/pos-totales.test.js`: 6 casos (sin descuento, descuento
  global + 1 alícuota, descuento global + 2 alícuotas — el caso real del
  hallazgo, descuento por línea + global combinados, descuento 100%,
  descuento fuera de rango).
- Suite completa: **145/145 archivos, 2024/2024 tests OK** (antes 144/2018).
  Cero regresiones en `tests/repos/pos.test.js` ni en el resto de POS.
- `check:migrations`: 0 colisiones sobre 498 archivos (sin cambios de
  schema en este fix, no aplica migración nueva).

## Pendiente real, sin cerrar

1. Decisión de negocio del redondeo a peso entero (arriba).
2. La decisión de negocio sobre `crear_nota_credito` y el tipo M, ya
   señalada en la Etapa 1, sigue sin resolver.
3. No se pudo probar contra el `venta_pos_items`/`facturas` reales de
   Supabase (sin salida de red al proyecto desde este entorno) — la
   verificación es a nivel de función pura + suite local. Recomendado:
   una venta de prueba con descuento global + catálogo de 2 alícuotas +
   pago a cuenta corriente, y confirmar que la Factura A sale con CAE.
