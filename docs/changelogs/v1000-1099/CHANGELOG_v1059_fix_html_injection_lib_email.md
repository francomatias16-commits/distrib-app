# v1059 — Fix: inyección de HTML sin escapar en los 5 templates de `lib/email.js`

## Hallazgo

Continuación del pendiente menor documentado en el changelog v1056
(fix de `lib/handlers/saas-alertas.js`): `lib/email.js` interpolaba
directo, sin escapar, `empresa?.nombre` (el mismo campo de
autoregistro del hallazgo de v1056) y varios campos de texto libre
más en el HTML de los 5 emails transaccionales del archivo —
`enviarEmailConfirmacionPedido`, `enviarEmailDespacho`,
`enviarEmailRecuperacionPassword`, `enviarEmailEstadoCuenta` y
`enviarEmailRecepcionProveedor`.

A diferencia de `saas-alertas.js` (donde el destinatario es siempre
el superadmin), acá el destinatario es un **cliente o proveedor de
la empresa** — un tercero distinto de quien carga el dato. Un
distribuidor que se autoregistra con un nombre malicioso, o un
cliente que carga notas de pedido con HTML activo, podía inyectar
HTML/enlaces de phishing en emails reales que le llegan a otro
cliente o proveedor de esa misma empresa.

Campos interpolados sin escapar, por función:

- **`enviarEmailConfirmacionPedido`**: `empresa?.nombre`,
  `cliente.razon_social`, `pedido.notas_cliente`, `nombre` de cada
  item.
- **`enviarEmailDespacho`**: `empresa?.nombre`, `cliente.razon_social`.
- **`enviarEmailRecuperacionPassword`**: `empresa?.nombre` y
  `linkRecuperacion` (este último en atributo `href`, riesgo de
  ruptura de atributo además de HTML injection).
- **`enviarEmailEstadoCuenta`**: `empresa?.nombre`,
  nombre del cliente, `numero` de factura, `descripcion` de cada
  movimiento, `enviadoPor?.nombre`, `empresa?.email` (en `mailto:`).
- **`enviarEmailRecepcionProveedor`**: `empresa?.nombre`,
  `razon_social`/`contacto` del proveedor, `numero` de la orden,
  `nombre` de cada item, `recepcion?.foto_url` (en `href`),
  `empresa?.email` (en `mailto:`).

## Fix

Se agrega un `escapeHtml()` centralizado en `lib/email.js` (mismo
criterio que el de `saas-alertas.js`, sin dependencia nueva) y se
aplica a los campos de arriba en las 5 funciones. Los `subject`
(campo de texto plano en el body JSON a la API de Resend, no HTML)
usan el valor **crudo**, no el ya escapado — solo se recortan
`\r\n` para evitar header injection — igual que en v1056; de lo
contrario el asunto del email mostraría entidades HTML literales
(`&amp;` en vez de `&`).

Los valores calculados con `formatPeso`/`formatFecha` no se tocan —
salen de `Number`/`Date`, no son texto libre.

## Alcance

Puntual a los 5 templates de `lib/email.js`. No se tocó
`saas-alertas.js` (ya resuelto en v1056) ni ningún otro handler.

## Verificación

- `node --check lib/email.js`: OK.
- Test de regresión nuevo, `tests/lib/email-html-injection.test.js`
  (7 tests, mockeando `fetch` y `demo-mode.js`): cubre escape de
  HTML en las 5 funciones (payload `<script>`/ruptura de atributo
  `href`), que el `subject` no escape entidades pero sí recorte
  `\r\n`, y que texto legítimo con apóstrofe/ampersand se siga
  viendo legible tras el escape. Corrido con vitest: 7/7 OK.
