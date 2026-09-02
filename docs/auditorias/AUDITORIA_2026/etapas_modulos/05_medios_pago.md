# Etapa 5 — Medios de pago online (Mercado Pago)

Alcance: `lib/handlers/pagos.js`, `frontend/cliente/checkout.html`,
`frontend/cliente/pedidos.html`, `frontend/cliente/cuenta.html`,
`frontend/admin/mercadopago-config.html`. Se excluye Mercado Pago Point
(terminal física de POS, integración distinta) — eso queda para la
etapa 7.

## Nota sobre los datos encontrados en producción
Durante la auditoría se detectaron 187 filas en `transacciones_pago` con
`proveedor='mercado_pago'` (97 aprobadas, 46 rechazadas, 44 pendientes,
abril–julio 2026), pese a que `integraciones_pago` está y estuvo siempre
vacía — es decir, ninguna empresa tuvo nunca credenciales de Mercado Pago
cargadas, y `crearPreferencia` no puede insertar en `transacciones_pago`
sin pasar antes por una integración activa. Confirmado con el usuario:
son datos migrados/de prueba, no transacciones reales. Se ignoran a los
fines de esta auditoría, pero quedan registrados acá por si aparecen de
nuevo en un reporte o dashboard sin este contexto.

## Resumen de hallazgos

| Hallazgo | Severidad | Estado |
|---|---|---|
| 1. El flujo de pago online era inalcanzable desde la interfaz del cliente — sin botón, sin manejo del retorno de Mercado Pago | 🔴 Alta | ✅ Corregido en código |
| 2. `verificarPago` (polling desde el navegador) no registraba el cobro en cta. cte. ni desbloqueaba al cliente tras un pago aprobado, a diferencia del webhook | 🔴 Alta | ✅ Corregido en código |
| 3. Email del pagador hardcodeado (`cliente@example.com`) en la preferencia de pago | 🟡 Media | ✅ Corregido en código |
| 4. (no era hallazgo formal, detectado de paso) Sin idempotencia en `crearPreferencia`: doble click generaba preferencias duplicadas en Mercado Pago para el mismo pedido | 🟡 Baja-media | ✅ Corregido en código |

Ningún hallazgo requirió migración SQL — todo el fix es de código
(`lib/handlers/pagos.js` + `frontend/cliente/pedidos.html`). Sin
migraciones, no hay nada aplicado en Supabase; **todo queda pendiente de
`git push`/deploy a Vercel**, igual que etapas 1-4.

## Hallazgo 1 — Pago online inalcanzable (🔴 Alta)

El backend (`crearPreferencia`, `verificarPago`, webhook) estaba completo
y funcional, pero no existía ningún punto de entrada real:

- Ningún archivo de `frontend/cliente/` llamaba a `crearPreferencia` ni
  mostraba un botón "pagar online" — ni en `checkout.html` (que es solo
  confirmación de pedido, sin pago), ni en `cuenta.html` (muestra el saldo
  de deuda pero no ofrece pagarlo), ni en `pedidos.html`.
- `pedidos.html` tampoco procesaba los query params `?pago=exitoso|
  fallido|pendiente&pedido=<id>` que Mercado Pago manda al volver del
  checkout (los mismos que arma `crearPreferencia` en `back_urls`) — un
  cliente que pagaba veía simplemente la lista de pedidos, sin ninguna
  confirmación.
- El admin tampoco tenía forma de generar y compartir un link de pago
  manualmente (se descartó como posible flujo alternativo — no existe).

**Fix aplicado:**
- `frontend/cliente/pedidos.html`: botón "Pagar online" en el detalle de
  cada pedido en estado `confirmado`/`pendiente`/`preparando`, que llama a
  `crearPreferencia` y redirige a `checkout_url`.
- Manejo de `?pago=...` al cargar la página: toast según resultado y
  re-verificación contra el backend (no alcanza con el query param solo,
  porque refleja lo que pasó en el navegador del cliente en el momento del
  redirect, no el estado real confirmado por Mercado Pago).

## Hallazgo 2 — `verificarPago` no acredita el cobro (🔴 Alta)

El webhook, tras un pago aprobado, llama a `registrar_cobro_completo` y
`desbloquearSiSaldado`. El path de `verificarPago` (el que ahora sí se usa
desde el botón nuevo, vía polling tras el redirect) marcaba el pedido como
`confirmado` pero se saltaba esos dos pasos — mismo bug que ya se había
corregido en el webhook en una auditoría anterior, sin corregir acá.
Ahora ambos paths quedan alineados.

## Hallazgo 3 — Email placeholder (🟡 Media)

`payer.email` iba siempre como `'cliente@example.com'`. Se cambió para
usar el email real (`pedidos.clientes.email`, con join agregado a la
query); si el cliente no tiene email cargado, se omite el campo en vez de
mandar un dato falso.

## Hallazgo 4 — Sin idempotencia (🟡 Baja-media, detectado de paso)

`crearPreferencia` no verificaba si ya existía una preferencia pendiente
para el mismo pedido antes de crear una nueva — un doble click generaba
dos preferencias distintas en Mercado Pago para el mismo pedido. Ahora se
busca la transacción pendiente más reciente para ese `pedido_id` y, si
tiene un `init_point` vigente, se reutiliza en vez de crear una nueva.

## Pendiente / fuera de alcance de esta etapa
- No se resolvió la concurrencia fina entre webhook y polling llegando
  casi simultáneamente (ambos podrían, en teoría, intentar registrar el
  cobro a la vez). El chequeo existente de "si ya está `completado`,
  devolver de caché" cubre el caso normal, pero no es un lock real. Si en
  producción se ve algún cobro duplicado, hay que revisarlo — no se tocó
  en esta pasada por alcance.
- No se agregó una vista de "estado de Mercado Pago configurado / no
  configurado" en el admin — el botón nuevo del cliente simplemente
  muestra el error del backend ("Mercado Pago no configurado para esta
  empresa") si la empresa no cargó credenciales.
