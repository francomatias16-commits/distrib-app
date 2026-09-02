# v443 — Fase 3.2 del plan de acción: esqueleto de tests unitarios (Vitest)

**Contexto:** continúa `plan-de-accion.md`. La 3.1 (CI con GitHub Actions)
ya estaba cerrada; esta entrega arranca la 3.2 — tests unitarios sobre lo
crítico, priorizado según el plan: cálculo de dinero, flujo de creación de
pedido, y webhooks.

## Setup

- `vitest` como devDependency. `vitest.config.js` apunta a `tests/**/*.test.js`.
- `npm test` (una corrida) y `npm run test:watch` (modo watch).
- `npm test` sumado como paso al workflow `.github/workflows/ci.yml`, antes
  de las auditorías — así un test roto frena el pipeline temprano.

## Decisión sobre `calcular_deuda_cliente` / `calcular_score_cliente`

Son funciones SQL (RPC de Postgres), no código JS — la aritmética en sí no
se puede testear con Vitest sin una base real de prueba (eso ya lo cubre
`npm run test:integration`). Lo que sí se aisló y testeó acá es la capa JS
que las envuelve, `lib/repos/scores.js`: que se llame a la RPC correcta con
los parámetros correctos, que un error de Supabase se propague con mensaje
identificable, y que `recalcularTodos` cuente bien éxitos/errores por
cliente sin cortar el batch ante el primer fallo (antes esto no tenía
ninguna cobertura y un solo cliente con datos raros podía tirar abajo el
recálculo de toda la empresa sin que se notara en los números finales).

## Extracción: cálculo de subtotal/IVA/total

El cálculo de money — subtotal, IVA por producto, total — vivía duplicado
dentro de dos handlers gigantes en `lib/handlers/pedidos.js` (uno para el
alta desde el portal del cliente, otro para el alta desde el admin), con
pequeñas diferencias que hacían fácil que una corrección se aplicara en un
lado y no en el otro (el mismo patrón de fondo detrás de CONS-01/02/03 en
la auditoría anterior).

Se extrajo a `lib/calc/pedido-totales.js` → `calcularTotalesPedido(items, { resolverPrecio, ivaMap })`,
función pura, sin tocar Supabase ni Express. Los dos call sites en
`pedidos.js` ahora la llaman, pasando cada uno su propia forma de resolver
el precio del servidor (no se unificó esa diferencia para no cambiar
comportamiento existente al refactorizar). 7 tests: descuento por item,
IVA variable por producto, IVA 21% por defecto si el producto no lo tiene
cargado, redondeo a 2 decimales, descuento 100%, y que nunca se confíe en
el `precio_unitario` que manda el cliente.

## Webhooks: "sin firma → debe rechazar"

Se exportaron (antes eran funciones internas, ahora `export`):
- `verificarFirmaMP` en `lib/handlers/pagos.js` (HMAC-SHA256, header `x-signature`).
- `firmaValidaDeMeta` en `lib/handlers/notif.js` (HMAC-SHA256, header `X-Hub-Signature-256`).

7 tests cada una: firma válida acepta; sin secreto configurado rechaza
(fail-closed, este es el caso SEC-013 que ya se corrigió una vez — el test
evita que alguien reintroduzca el fail-open sin darse cuenta); falta el
header; header malformado; secreto incorrecto; body/params alterados
después de firmar.

## Borrador de pedido por WhatsApp

`crearPedidoDesdeItemsWhatsapp` (`lib/handlers/notif.js`) es la tercera
réplica del mismo motor de precios/stock — portal cliente, admin, y ahora
WhatsApp — y la más sensible de las tres porque la confirma un asistente
automático sin que un humano revise el pedido antes. Se refactorizó para
usar también `calcularTotalesPedido` (el borrador de WhatsApp no soporta
descuento por ítem, así que siempre manda `descuento_pct: 0` — mismo
resultado que antes) y se exportó para poder testearla directamente.

13 tests en `tests/handlers/whatsapp-pedido-borrador.test.js`, mockeando
`crearClienteSupabaseLazy` (sin env vars ni base real):
- Camino feliz: confirma y devuelve `pedidoId`/`numeroPedido`; items sin
  descuento; `canal: 'whatsapp'` y `vendedor_id: null` en la RPC.
- Cliente no encontrado / inactivo.
- Stock insuficiente (incluyendo que reste `cantidad_reservada` antes de
  comparar contra lo pedido).
- Falla la resolución de precios.
- Producto que no pertenece a la empresa.
- Supera el límite de crédito del cliente (y que `limite_credito: 0`
  signifique "sin límite", no "límite cero").
- Error de conexión en la RPC `crear_pedido_cliente`.
- La RPC responde `ok:false` (ej. stock cambió justo antes de confirmar) y
  se propaga el motivo.

## Pendiente para la próxima

- El resto de `lib/repos/` (clientes, productos, etc.) sigue sin cobertura;
  el patrón de mock de `db` usado en `tests/repos/scores.test.js` sirve de
  plantilla para sumarlos de a poco.

## Archivos

- `vitest.config.js` (nuevo)
- `lib/calc/pedido-totales.js` (nuevo)
- `lib/handlers/pedidos.js` (usa la función extraída en los dos call sites)
- `lib/handlers/pagos.js` (`verificarFirmaMP` ahora exportada)
- `lib/handlers/notif.js` (`firmaValidaDeMeta` y `crearPedidoDesdeItemsWhatsapp` ahora exportadas; usa la función de cálculo extraída)
- `tests/calc/pedido-totales.test.js` (nuevo, 7 tests)
- `tests/webhooks/mp-firma.test.js` (nuevo, 7 tests)
- `tests/webhooks/whatsapp-firma.test.js` (nuevo, 7 tests)
- `tests/repos/scores.test.js` (nuevo, 9 tests)
- `tests/handlers/whatsapp-pedido-borrador.test.js` (nuevo, 13 tests)
- `.github/workflows/ci.yml` (paso `npm test` sumado)
- `plan-de-accion.md` (3.2 marcada, detalle de lo entregado y lo pendiente)
- `package.json` (`vitest` devDependency, scripts `test` / `test:watch`)

**Total: 43 tests, 43 verdes.**
